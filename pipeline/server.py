"""Pipeline step 8 (WEB): serve the site and the live endpoint the viewer calls with ?source=api.

    GET /api/patch?ra=<deg>&dec=<deg>&fov=<deg>&det=<all|1..6>[&max=60]

Returns the same JSON as public/data/<id>.json (contract: public/data/README.md), with absolute frame paths.
  1. A spot covered by a pre-processed patch (data/patches.json) is answered from those files at once,
     so the five challenge targets (and the other 95) never depend on IRSA being fast.
  2. A spot processed live before is answered from data/live/<key>.json.
  3. Anything else is processed now, a light version of steps 1-4 + 7: list the SPHEREx images covering
     the spot (IRSA TAP), take up to --max of them spread over every visit and detector, read only the
     cutout bytes from NASA's AWS copy, clean them (step 3), stack each detector per visit on a north-up
     grid (step 4), and write PNG frames + JSON (step 7). Typically 20-60 s; then it is cached.
     No SPHEREx images there -> HTTP 404 with {"status": "no-coverage", "nearest": {...}}.

Run:   python pipeline/server.py [--port 8000] [--site public]
Open:  http://localhost:8000/viewer.html?ra=10.68&dec=41.27&fov=0.1667&source=api
"""
import argparse
import hashlib
import json
import math
import os
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
LOCKS = defaultdict(threading.Lock)


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


def process(ra, dec, fov, max_images, key, log):
    t0 = time.time()
    rows = spherex_images_at(ra, dec)
    if not rows:
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

    with ThreadPoolExecutor(12) as ex:
        recs = [r for r in ex.map(one, rows) if r]
    log(f"{len(recs)} images downloaded and cleaned ({time.time() - t0:.0f} s)")
    if not recs:
        return None
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
    json.dump(doc, open(os.path.join(fdir + ".json"), "w"), indent=1)
    log(f"done: {len(frames)} frames ({time.time() - t0:.0f} s)")
    return doc


class Handler(SimpleHTTPRequestHandler):
    max_images = 60

    def __init__(self, *a, **k):
        super().__init__(*a, directory=SITE, **k)

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        u = urlparse(self.path)
        if u.path.rstrip("/").endswith("/api/patch"):
            return self.api_patch(parse_qs(u.query))
        return super().do_GET()

    def api_patch(self, q):
        try:
            ra, dec = float(q["ra"][0]) % 360, float(q["dec"][0])
            fov = min(max(float(q.get("fov", ["0.25"])[0]), 0.02), 0.5)
            mx = int(q.get("max", [self.max_images])[0])
        except (KeyError, ValueError):
            return self.send_json(400, {"error": "need numeric ra, dec (degrees)"})
        near = nearest_patch(ra, dec)
        if near and near[0] <= (near[1].get("fov_deg") or 0.25) / 2 * 0.95:
            p = near[1]
            doc = json.load(open(os.path.join(SITE, "data", p["id"] + ".json")))
            return self.send_json(200, absolutize(doc, "data"))
        fov = round(fov, 3)
        key = "p" + hashlib.md5(f"{ra:.3f},{dec:.3f},{fov}".encode()).hexdigest()[:10]
        path = os.path.join(SITE, "data", "live", key + ".json")
        with LOCKS[key]:
            if not os.path.exists(path):
                log = lambda m: print(f"[live {key} {ra:.3f},{dec:+.3f}] {m}", flush=True)  # noqa: E731
                try:
                    doc = process(ra, dec, fov, mx, key, log)
                except Exception:  # noqa: BLE001
                    traceback.print_exc()
                    return self.send_json(502, {"error": "processing failed, try again"})
                if doc is None:
                    nearest = near and dict(id=near[1]["id"], title=near[1].get("title"), ra=near[1]["ra"],
                                            dec=near[1]["dec"], sepDeg=near[0])
                    return self.send_json(404, {"status": "no-coverage", "nearest": nearest})
        return self.send_json(200, json.load(open(path)))


def main():
    global SITE
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--site", default=SITE)
    ap.add_argument("--max", type=int, default=60, help="images per live request (more = slower, cleaner)")
    a = ap.parse_args()
    SITE = os.path.abspath(a.site)
    Handler.max_images = a.max
    print(f"Serving {SITE} on http://localhost:{a.port}  (live endpoint: /api/patch)", flush=True)
    ThreadingHTTPServer(("", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
