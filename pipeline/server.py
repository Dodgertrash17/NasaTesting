"""Pipeline step 8 (WEB): serve the site and the live endpoint the viewer uses for any RA/Dec.

    GET /api/patch?ra=<deg>&dec=<deg>&fov=<deg>[&det=all][&layers=gaia,wise][&max=36]

Returns the same JSON as public/data/<id>.json (contract: public/data/README.md), with absolute frame paths.
  1. A spot covered by a pre-processed patch (data/patches.json) is answered from those files at once.
  2. A spot processed live before is answered from data/live/<key>.json (instant).
  3. Anything else starts a background job and answers HTTP 202 with its progress:
        {"status": "working", "stage": "download", "step": 2, "steps": 4, "done": 14, "total": 36,
         "message": "Downloading and cleaning SPHEREx images", "elapsed_s": 12}
     The browser asks again every second or two with the same URL; when the job is finished the same
     URL answers 200 with the patch. The job is a light version of steps 1-4 + 7: list the SPHEREx images
     covering the spot (IRSA TAP), take up to --max of them spread over every visit and detector, read only
     the cutout bytes from NASA's AWS copy, clean them (step 3), stack each detector per visit on a north-up
     grid (step 4), and write PNG frames + JSON (step 7). Typically 20-50 s.
     No SPHEREx images there -> HTTP 404 with {"status": "no-coverage", "nearest": {...}}.

layers: extra catalogues to fetch for the field, drawn over the image by the viewer. "gaia" = Gaia DR3
stars, "wise" = CatWISE2020 infrared sources (both from IRSA, run while the images download). SPHEREx
images are always loaded. Leave a layer out (layers=) to skip its query.

Storage: live results are a CACHE on the machine running this server, not part of the website build.
Raw and cleaned frames are deleted as soon as a patch is exported, and data/live is kept under
--live-max-mb (default 500 MB) by deleting the least recently viewed patches first. Keep
public/data/live out of git (.gitignore) so it never reaches the deployed site.

Run:   python pipeline/server.py [--port 8000] [--site public] [--max 36] [--live-max-mb 500]
Host:  render.yaml at the repo root runs this on Render's free plan (see pipeline/RENDER.md).
Open:  http://localhost:8000/search.html  (raw search falls back to this live endpoint)
"""
import argparse
import hashlib
import json
import math
import os
import shutil
import sys
import threading
import time
import traceback
import warnings
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import numpy as np

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from irsa import spherex_images_at  # noqa: E402
from step2_download import fetch_s3, resolve_paths, did_of, PAD  # noqa: E402
from step3_clean import clean_one  # noqa: E402
from step4_align_stack import make_grid, reproject, stack_frames  # noqa: E402
from step7_export import display_scale, to_u8, save_png, mjd_to_date, robust, fill_holes  # noqa: E402

PIX = 6.15
SITE = os.path.join(os.path.dirname(HERE), "public")
WORK = os.environ.get("SPHEREX_LIVE_CACHE", os.path.join(HERE, "cache", "live"))
JOBS = {}                       # key -> progress dict of the job making that patch
# Hosting knobs (environment variables, so a host like Render can set them without code changes):
#   ALLOWED_ORIGINS  comma-separated sites allowed to call this server from the browser ("*" = any)
#   LIVE_MAX_JOBS    live searches processed at the same time (others wait their turn; keeps memory low)
#   LIVE_THREADS     parallel downloads per search
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
JOB_SLOTS = threading.Semaphore(int(os.environ.get("LIVE_MAX_JOBS", "2")))
THREADS = int(os.environ.get("LIVE_THREADS", "12"))
JOBS_LOCK = threading.Lock()
LIVE_MAX_MB = 500
LAYERS = ("gaia", "wise")
STEPS = {"find": (1, "Finding SPHEREx images of this spot"),
         "download": (2, "Downloading and cleaning SPHEREx images"),
         "stack": (3, "Lining up and stacking the images"),
         "save": (4, "Saving the images"),
         "catalogs": (4, "Looking up catalogue sources")}


def sep_deg(ra1, de1, ra2, de2):
    r = math.radians
    c = math.sin(r(de1)) * math.sin(r(de2)) + math.cos(r(de1)) * math.cos(r(de2)) * math.cos(r(ra1 - ra2))
    return math.degrees(math.acos(max(-1, min(1, c))))


def patches():
    try:
        return json.load(open(os.path.join(SITE, "data", "patches.json")))
    except FileNotFoundError:
        return []


def nearest_patch(ra, dec):
    best = None
    for p in patches():
        if p.get("ra") is None:
            continue
        d = sep_deg(ra, dec, p["ra"], p["dec"])
        if best is None or d < best[0]:
            best = (d, p)
    return best


def absolutize(doc, base):
    for f in doc.get("frames", []):
        for k in ("file", "flags_file"):
            if f.get(k) and not f[k].startswith(("/", "http")):
                f[k] = f"/{base}/{f[k]}"
    return doc


def group_visits(rows, gap=20.0):
    rows = sorted(rows, key=lambda r: r["t_min"])
    v, last = -1, None
    for r in rows:
        if last is None or r["t_min"] - last > gap:
            v += 1
        r["visit"] = v
        last = r["t_min"]
    return rows


def pick(rows, max_images):
    """Spread the budget over every (visit, detector), keeping a range of wavelengths in each."""
    groups = defaultdict(list)
    for r in rows:
        groups[(r["visit"], r["detector"])].append(r)
    per = max(2, max_images // max(1, len(groups)))
    keep = []
    for g in groups.values():
        g.sort(key=lambda r: r["em_min_um"])
        step = max(1, len(g) / per)
        keep += [g[int(i * step)] for i in range(min(per, len(g)))]
    return keep[: max(max_images, 2 * len(groups))]


def field_catalog(layer, ra, dec, fov, limit=300):
    """Brightest sources of one catalogue in the field, as viewer overlay rows."""
    from irsa import tap
    r = fov / 2 * 1.42
    if layer == "gaia":
        rows = tap(f"SELECT TOP {limit} source_id, ra, dec, phot_g_mean_mag FROM gaia_dr3_source WHERE "
                   f"CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',{ra},{dec},{r}))=1 ORDER BY phot_g_mean_mag")
        return [dict(ra=round(float(x["ra"]), 6), dec=round(float(x["dec"]), 6), epoch=2016.0,
                     label=f"Gaia DR3 {x['source_id']}", mag=round(float(x["phot_g_mean_mag"]), 2))
                for x in rows if x.get("phot_g_mean_mag") not in (None, "")]
    rows = tap(f"SELECT TOP {limit} source_name, ra, dec, w2mpro, meanobsmjd FROM catwise_2020 WHERE "
               f"CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',{ra},{dec},{r}))=1 ORDER BY w2mpro")
    return [dict(ra=round(float(x["ra"]), 6), dec=round(float(x["dec"]), 6), label="CWISE " + x["source_name"].strip(),
                 epoch=round(2000 + (float(x["meanobsmjd"]) - 51544.5) / 365.25, 2), mag=round(float(x["w2mpro"]), 2))
            for x in rows if x.get("w2mpro") not in (None, "")]


def start_catalogs(ex, layers, ra, dec, fov, log):
    futs = {layer: ex.submit(field_catalog, layer, ra, dec, fov) for layer in layers}

    def collect():
        out = {}
        for layer, f in futs.items():
            try:
                out[layer] = f.result()
            except Exception as e:  # noqa: BLE001
                log(f"{layer} lookup failed: {str(e)[:80]}")
        return out
    return collect


def process(ra, dec, fov, max_images, key, log, progress, layers=()):
    t0 = time.time()
    progress("find")
    side = ThreadPoolExecutor(2)                              # catalogue lookups run during the downloads
    collect = start_catalogs(side, layers, ra, dec, fov, log)
    rows = spherex_images_at(ra, dec)
    if not rows:
        side.shutdown(wait=False, cancel_futures=True)
        return None
    rows = pick(group_visits(rows), max_images)
    log(f"{len(rows)} images selected ({time.time() - t0:.0f} s)")
    paths = resolve_paths(did_of(r["access_url"]) for r in rows)
    d = os.path.join(WORK, key)
    os.makedirs(os.path.join(d, "clean"), exist_ok=True)
    t = dict(id=key, name="", ra=ra, dec=dec, epoch=2026.0)
    size = min(max(fov * PAD, 0.05), 0.75)     # padded so rotated detector cutouts fill the grid

    def one(r):
        uri = paths.get(did_of(r["access_url"]))
        if not uri:
            return None
        fname = f"{r['obs_id']}_D{r['detector']}.fits"
        raw = os.path.join(d, fname)
        try:
            if not os.path.exists(raw):
                fetch_s3(uri, ra, dec, size, raw)
            row = dict(file=fname, obs_id=r["obs_id"], mjd=r["t_min"], visit=r["visit"], detector=r["detector"])
            hl, rec = clean_one(raw, t, row)
            hl.writeto(os.path.join(d, "clean", fname), overwrite=True)
            os.remove(raw)
            return rec
        except Exception as e:  # noqa: BLE001
            log(f"skip {fname}: {str(e)[:80]}")
            return None

    progress("download", 0, len(rows))
    recs, done = [], 0
    with ThreadPoolExecutor(THREADS) as ex:
        for rec in ex.map(one, rows):
            done += 1
            progress("download", done, len(rows))
            if rec:
                recs.append(rec)
    log(f"{len(recs)} images downloaded and cleaned ({time.time() - t0:.0f} s)")
    if not recs:
        side.shutdown(wait=False, cancel_futures=True)
        return None
    progress("stack")
    grid, n = make_grid(ra, dec, fov)
    by = defaultdict(list)
    for r in recs:
        by[(int(r["visit"]), int(r["detector"]))].append(r)
    visits = sorted({v for v, _ in by})
    stacks, meta = {}, {}
    for (v, det), rs in by.items():
        ims = []
        for r in rs:
            im, _, sat = reproject(os.path.join(d, "clean", r["file"]), grid, n)
            ims.append(im)
        m, _ = stack_frames(ims)
        # no background flattening here: each frame's sky level is already removed in cleaning, and a
        # surface fit over a small live field eats into galaxies and nebulae that fill it
        stacks[(v, det)] = m
        lams = [r["wavelength_um"] for r in rs if np.isfinite(r["wavelength_um"])]
        meta[(v, det)] = dict(n=len(rs), mjd=float(np.mean([float(r["mjd"]) for r in rs])),
                              wl=[round(min(lams), 3), round(max(lams), 3)] if lams else None,
                              flux=robust([r["flux_ujy"] for r in rs if not r["saturated"]])[0])
    for v in visits:
        dets = [det for (vv, det) in stacks if vv == v]
        cube = np.array([stacks[(v, det)] for det in dets])
        ncov = np.isfinite(cube).sum(axis=0)
        stacks[(v, "all")] = np.where(ncov >= max(1, (len(dets) + 1) // 2), np.nanmean(cube, axis=0), np.nan)
        ms = [meta[(v, det)] for det in dets]
        wls = [m["wl"] for m in ms if m["wl"]]
        meta[(v, "all")] = dict(n=sum(m["n"] for m in ms), mjd=float(np.mean([m["mjd"] for m in ms])),
                                wl=[min(w[0] for w in wls), max(w[1] for w in wls)] if wls else None, flux=None)
    progress("save")
    # export (step 7 style): one stretch per detector, shared by all visits; row 0 = north
    fdir = os.path.join(SITE, "data", "live", key)
    os.makedirs(fdir, exist_ok=True)
    frames, lc, used = [], [], []
    for det in ["all", 1, 2, 3, 4, 5, 6]:
        keys = [(v, det) for v in visits if (v, det) in stacks and np.isfinite(stacks[(v, det)]).any()]
        if not keys:
            continue
        sc = display_scale(np.array([stacks[k] for k in keys]))
        for k in keys:
            m = meta[k]
            mjd = round(m["mjd"], 3)
            while any(abs(mjd - u) < 0.012 for u in used):
                mjd = round(mjd + 0.012, 3)
            used.append(mjd)
            name = f"v{k[0]:02d}_{det}"
            img = stacks[k][::-1]
            save_png(to_u8(fill_holes(img), *sc), os.path.join(fdir, name + ".png"))
            save_png(np.where(~np.isfinite(img), 255, 0).astype(np.uint8), os.path.join(fdir, name + "_flags.png"))
            frames.append(dict(file=f"/data/live/{key}/{name}.png", flags_file=f"/data/live/{key}/{name}_flags.png",
                               mjd=mjd, detector=det, wavelength_um=m["wl"], n_exposures=m["n"],
                               band="All 6 detectors added" if det == "all" else f"Detector {det}, stacked",
                               flags=[f"{m['n']} exposures, around {mjd_to_date(m['mjd'])}"]))
            if m["flux"] is not None and np.isfinite(m["flux"]):
                lc.append(dict(mjd=mjd, flux=round(m["flux"], 2), err=None, flagged=False, unit="uJy"))
    frames.sort(key=lambda f: (str(f["detector"]), f["mjd"]))
    doc = dict(patch=dict(id=key, name=f"SPHEREx {ra:.4f} {dec:+.4f}", width_px=n, height_px=n, ra=ra, dec=dec,
                          fov_deg=fov, pixel_scale_arcsec=PIX, simulated=False,
                          source=f"processed live from {len(recs)} SPHEREx images in {time.time() - t0:.0f} s"),
               frames=frames, light_curve=lc, predictions=[])
    if layers:
        progress("catalogs")
        doc["overlays"] = collect()
    side.shutdown(wait=False)
    shutil.rmtree(d, ignore_errors=True)                     # cleaned frames are not needed any more
    with open(fdir + ".json.part", "w") as fh:
        json.dump(doc, fh, indent=1)
    os.replace(fdir + ".json.part", fdir + ".json")           # appears only when complete
    log(f"done: {len(frames)} frames ({time.time() - t0:.0f} s)")
    return doc


def live_dir():
    return os.path.join(SITE, "data", "live")


def evict(keep=None):
    """Keep data/live under LIVE_MAX_MB: delete the least recently viewed patches first."""
    root = live_dir()
    if not os.path.isdir(root):
        return
    items = []
    for f in os.listdir(root):
        if not f.endswith(".json"):
            continue
        k = f[:-5]
        size = os.path.getsize(os.path.join(root, f))
        sub = os.path.join(root, k)
        if os.path.isdir(sub):
            size += sum(os.path.getsize(os.path.join(sub, x)) for x in os.listdir(sub))
        items.append((os.path.getmtime(os.path.join(root, f)), k, size))
    total = sum(i[2] for i in items)
    for _, k, size in sorted(items):
        if total <= LIVE_MAX_MB * 1e6:
            break
        if k == keep:
            continue
        os.remove(os.path.join(root, k + ".json"))
        shutil.rmtree(os.path.join(root, k), ignore_errors=True)
        total -= size
        print(f"[live] evicted {k} ({size / 1e6:.1f} MB) to stay under {LIVE_MAX_MB} MB", flush=True)


def run_job(key, ra, dec, fov, mx, layers, near):
    job = JOBS[key]
    log = lambda m: print(f"[live {key} {ra:.3f},{dec:+.3f}] {m}", flush=True)  # noqa: E731

    def progress(stage, done=None, total=None):
        step, msg = STEPS[stage]
        if stage == "catalogs":
            msg = "Looking up " + " and ".join({"gaia": "Gaia", "wise": "WISE"}[x] for x in layers) + " sources"
        job.update(stage=stage, step=step, message=msg, done=done, total=total)

    if not JOB_SLOTS.acquire(blocking=False):
        job.update(message="Waiting for another search on this server to finish")
        JOB_SLOTS.acquire()
    try:
        doc = process(ra, dec, fov, mx, key, log, progress, layers)
        if doc is None:
            nearest = near and dict(id=near[1]["id"], title=near[1].get("title"), ra=near[1]["ra"],
                                    dec=near[1]["dec"], sepDeg=near[0])
            job.update(status="no-coverage", nearest=nearest)
        else:
            job.update(status="done")
            evict(keep=key)
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        job.update(status="error")
    finally:
        JOB_SLOTS.release()
    job["finished"] = time.time()


def add_layers(doc, path, layers, ra, dec, fov):
    """A cached live patch made without some layer the user now wants: fetch just that catalogue."""
    have = doc.setdefault("overlays", {})
    missing = [x for x in layers if x not in have]
    for x in missing:
        try:
            have[x] = field_catalog(x, ra, dec, fov)
        except Exception:  # noqa: BLE001
            pass
    if missing:
        with open(path + ".part", "w") as fh:
            json.dump(doc, fh, indent=1)
        os.replace(path + ".part", path)
    return doc


def only_layers(doc, layers):
    if "overlays" in doc:
        doc["overlays"] = {k: v for k, v in doc["overlays"].items() if k in layers}
    return doc


class Handler(SimpleHTTPRequestHandler):
    max_images = 36

    def __init__(self, *a, **k):
        super().__init__(*a, directory=SITE, **k)

    def end_headers(self):
        # CORS on every response (JSON and PNG frames), so a site on another host (e.g. Vercel) can call
        # the API and also read the frame pixels in a canvas (the viewer measures brightness from them).
        origin = self.headers.get("Origin")
        if "*" in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", "*")
        elif origin and (origin in ALLOWED_ORIGINS or
                         any(o.startswith("*.") and origin.endswith(o[1:]) for o in ALLOWED_ORIGINS)):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        super().end_headers()

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        u = urlparse(self.path)
        p = u.path.rstrip("/")
        if p.endswith("/api/patch"):
            return self.api_patch(parse_qs(u.query))
        if p.endswith("/api/health"):
            return self.send_json(200, {"ok": True, "jobs_running": sum(j["status"] == "working" for j in JOBS.values())})
        return super().do_GET()

    def log_message(self, fmt, *args):  # quieter logs: skip the browser's progress polling
        if " 202 " not in fmt % args:
            super().log_message(fmt, *args)

    def api_patch(self, q):
        try:
            ra, dec = float(q["ra"][0]) % 360, float(q["dec"][0])
            fov = min(max(float(q.get("fov", ["0.25"])[0]), 0.02), 0.5)
            mx = min(max(int(q.get("max", [self.max_images])[0]), 6), 120)
        except (KeyError, ValueError):
            return self.send_json(400, {"error": "need numeric ra, dec (degrees)"})
        if not -90 <= dec <= 90:
            return self.send_json(400, {"error": "dec must be between -90 and 90"})
        layers = tuple(x for x in ",".join(q.get("layers", ["gaia,wise"])).split(",") if x in LAYERS)
        near = nearest_patch(ra, dec)
        if near and near[0] <= (near[1].get("fov_deg") or 0.25) / 2 * 0.95:
            p = near[1]
            with open(os.path.join(SITE, "data", p["id"] + ".json")) as fh:
                doc = json.load(fh)
            return self.send_json(200, only_layers(absolutize(doc, "data"), layers))
        fov = round(fov, 3)
        key = "p" + hashlib.md5(f"{ra:.3f},{dec:.3f},{fov}".encode()).hexdigest()[:10]
        path = os.path.join(live_dir(), key + ".json")
        with JOBS_LOCK:
            job = JOBS.get(key)
            ready = os.path.exists(path) and not (job and job["status"] == "working")
            if not ready and (job is None or job["status"] in ("error", "done") or
                              (job["status"] == "no-coverage" and time.time() - job["finished"] > 3600)):
                job = JOBS[key] = dict(status="working", stage="find", step=1, steps=4, message=STEPS["find"][1],
                                       done=None, total=None, started=time.time())
                threading.Thread(target=run_job, args=(key, ra, dec, fov, mx, layers, near), daemon=True).start()
        if ready:
            with open(path) as fh:
                doc = json.load(fh)
            os.utime(path)                                       # mark as recently viewed (cache eviction)
            return self.send_json(200, only_layers(add_layers(doc, path, layers, ra, dec, fov), layers))
        if job["status"] == "no-coverage":
            return self.send_json(404, {"status": "no-coverage", "nearest": job.get("nearest")})
        if job["status"] == "error":
            JOBS.pop(key, None)                                  # the next request starts over
            return self.send_json(502, {"status": "error", "error": "processing failed, try again"})
        out = {k: v for k, v in job.items() if k in ("status", "stage", "step", "steps", "message", "done", "total")}
        out["elapsed_s"] = round(time.time() - job["started"])
        return self.send_json(202, out)


def main():
    global SITE, LIVE_MAX_MB
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    ap.add_argument("--site", default=SITE)
    ap.add_argument("--max", type=int, default=36, help="images per live request (more = slower, cleaner)")
    ap.add_argument("--live-max-mb", type=float, default=500, help="cap on data/live; least recently viewed go first")
    a = ap.parse_args()
    SITE = os.path.abspath(a.site)
    Handler.max_images = a.max
    LIVE_MAX_MB = a.live_max_mb
    evict()
    print(f"Serving {SITE} on http://localhost:{a.port}  (live endpoint: /api/patch)", flush=True)
    ThreadingHTTPServer(("", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
