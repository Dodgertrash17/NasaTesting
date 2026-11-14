"""Pipeline step 2 (DOWNLOAD): fetch small cutouts of every SPHEREx image of each target.

For each target in out/targets.json:
  1. read the image list from step 1 (out/inventory/<id>.csv)
  2. look up each image's file path in IRSA's CAOM tables (one query per 300 images)
  3. ask IRSA's cutout service for a FOV x FOV box around the target (IBE ?center=&size=)
  4. keep IMAGE, FLAGS, VARIANCE, ZODI and WCS-WAVE, drop the 5 MB PSF cube, and save
     the slimmed file (~0.35 MB) to cache/<id>/<obs_id>_D<n>.fits

Deep-field targets (near the ecliptic poles) have thousands of images; --cap keeps at most N
images per (visit, detector), spread evenly in wavelength.

Usage:  python step2_download.py --only barnard,wise0855 [--fov 0.25] [--workers 8] [--cap 20]
Writes timing to out/step2_timing.json so we can plan hackathon day.
"""
import argparse
import csv
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from irsa import tap  # noqa: E402

from astropy.io import fits  # noqa: E402

OUT = os.path.join(HERE, "out")
CACHE = os.environ.get("SPHEREX_CACHE", os.path.join(HERE, "cache"))
KEEP = ("IMAGE", "FLAGS", "VARIANCE", "ZODI", "WCS-WAVE")


def did_of(access_url):
    return urllib.parse.parse_qs(urllib.parse.urlparse(access_url).query)["ID"][0]


def resolve_paths(dids):
    """obs_publisher_did -> 'ibe/data/spherex/...fits' (CAOM artifact uri)."""
    out = {}
    dids = list(dids)
    for i in range(0, len(dids), 300):
        chunk = ",".join("'" + d.replace("'", "") + "'" for d in dids[i:i + 300])
        rows = tap("SELECT p.obs_publisher_did, a.uri FROM spherex.plane p JOIN spherex.artifact a "
                   f"ON a.planeid=p.planeid WHERE p.obs_publisher_did IN ({chunk}) AND a.producttype='science'")
        out.update({r["obs_publisher_did"]: r["uri"] for r in rows})
    return out


def cap_rows(rows, cap):
    groups = defaultdict(list)
    for r in rows:
        groups[(r["visit"], r["detector"])].append(r)
    keep = []
    for g in groups.values():
        g.sort(key=lambda r: float(r["em_min_um"]))
        if len(g) > cap:
            step = len(g) / cap
            g = [g[int(i * step)] for i in range(cap)]
        keep += g
    return sorted(keep, key=lambda r: float(r["mjd"]))


# The detector is rotated relative to north by a different roll angle every visit. A square cutout of
# exactly FOV only covers the inscribed circle of the north-up grid, leaving empty corners. sqrt(2) plus
# a margin for the proper-motion shift guarantees the whole FOV x FOV grid is covered at any angle.
PAD = 1.5


def fetch_cutout(uri, ra, dec, size, dest, retries=5):
    url = f"https://irsa.ipac.caltech.edu/{uri}?center={ra:.6f},{dec:.6f}&size={size}&gzip=false"
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=180) as r:
                raw = r.read()
            if not raw.startswith(b"SIMPLE"):
                raise RuntimeError(raw[:80].decode(errors="replace"))   # e.g. "Server busy, retry later."
            with fits.open(io.BytesIO(raw)) as h:
                slim = fits.HDUList([fits.PrimaryHDU(header=h[0].header)] + [h[k].copy() for k in KEEP if k in h])
                slim.writeto(dest + ".part", overwrite=True)
            os.replace(dest + ".part", dest)
            return len(raw), os.path.getsize(dest)
        except Exception as e:  # noqa: BLE001
            if attempt == retries - 1:
                raise
            time.sleep(2 * 2 ** attempt)


S3 = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"


def fetch_s3(uri, ra, dec, size, dest, retries=4):
    """Faster path: read only the cutout's bytes straight from NASA's public AWS copy (HTTP range
    requests), skipping the PSF cube entirely. ~1 s and ~0.4 MB per image instead of ~4 s and 5.4 MB."""
    from astropy.wcs import WCS
    url = S3 + uri.replace("ibe/data/spherex/", "")
    for attempt in range(retries):
        try:
            with fits.open(url, use_fsspec=True, fsspec_kwargs={"block_size": 256 * 1024}) as h:
                hd = h["IMAGE"].header
                w = WCS(hd)
                x, y = w.world_to_pixel_values(ra, dec)
                ny, nx = hd["NAXIS2"], hd["NAXIS1"]
                half = int(round(size * 3600 / 6.15 / 2))
                x0, y0 = max(0, int(round(float(x))) - half), max(0, int(round(float(y))) - half)
                x1, y1 = min(nx, x0 + 2 * half), min(ny, y0 + 2 * half)
                if x1 <= x0 or y1 <= y0:
                    raise RuntimeError("target off image")
                hdus = [fits.PrimaryHDU(header=h[0].header)]
                for k in KEEP[:-1]:
                    sh = h[k].header.copy()
                    for key, off in (("CRPIX1", x0), ("CRPIX2", y0), ("CRPIX1A", x0), ("CRPIX2A", y0),
                                     ("CRPIX1W", x0), ("CRPIX2W", y0)):
                        if key in sh:
                            sh[key] = sh[key] - off
                    hdus.append(fits.ImageHDU(h[k].section[y0:y1, x0:x1], header=sh, name=k))
                hdus.append(h["WCS-WAVE"].copy())
                fits.HDUList(hdus).writeto(dest + ".part", overwrite=True)
            os.replace(dest + ".part", dest)
            sz = os.path.getsize(dest)
            return sz, sz
        except Exception:  # noqa: BLE001
            if attempt == retries - 1:
                raise
            time.sleep(2 * 2 ** attempt)


def run_target(t, a):
    t0 = time.time()
    rows = list(csv.DictReader(open(os.path.join(OUT, "inventory", t["id"] + ".csv"))))
    n_all = len(rows)
    rows = cap_rows(rows, a.cap)
    paths = resolve_paths(did_of(r["access_url"]) for r in rows)
    t_lookup = time.time() - t0
    d = os.path.join(CACHE, t["id"])
    os.makedirs(d, exist_ok=True)
    jobs, done, failed, raw_bytes, kept_bytes = [], 0, [], 0, 0
    with ThreadPoolExecutor(a.workers) as ex:
        for r in rows:
            uri = paths.get(did_of(r["access_url"]))
            dest = os.path.join(d, f"{r['obs_id']}_D{r['detector']}.fits")
            if not uri:
                failed.append(r["obs_id"]); continue
            if os.path.exists(dest):
                done += 1; continue
            fn = fetch_s3 if a.source == "s3" else fetch_cutout
            jobs.append(ex.submit(fn, uri, t["ra"], t["dec"], a.fov * PAD, dest))
        for j in as_completed(jobs):
            try:
                rb, kb = j.result(); raw_bytes += rb; kept_bytes += kb; done += 1
            except Exception as e:  # noqa: BLE001
                failed.append(str(e)[:80])
    # manifest of what is in the cache, for step 3
    with open(os.path.join(d, "manifest.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()) + ["file"])
        w.writeheader()
        for r in rows:
            f = f"{r['obs_id']}_D{r['detector']}.fits"
            if os.path.exists(os.path.join(d, f)):
                w.writerow({**r, "file": f})
    res = dict(id=t["id"], images_listed=n_all, images_selected=len(rows), downloaded=done, failed=len(failed),
               lookup_s=round(t_lookup, 1), total_s=round(time.time() - t0, 1),
               transfer_mb=round(raw_bytes / 1e6, 1), stored_mb=round(kept_bytes / 1e6, 1))
    print(json.dumps(res), flush=True)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only")
    ap.add_argument("--fov", type=float, default=0.25)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--cap", type=int, default=20)
    ap.add_argument("--source", choices=["s3", "irsa"], default="s3",
                    help="s3 = range-read NASA's AWS copy (fast); irsa = IRSA cutout service")
    a = ap.parse_args()
    targets = json.load(open(os.path.join(OUT, "targets.json")))
    if a.only:
        keep = a.only.split(",")
        targets = [t for t in targets if t["id"] in keep]
    res = [run_target(t, a) for t in targets]
    tf = os.path.join(OUT, "step2_timing.json")
    old = json.load(open(tf)) if os.path.exists(tf) else []
    old = [o for o in old if o["id"] not in {r["id"] for r in res}] + res
    json.dump(old, open(tf, "w"), indent=1)


if __name__ == "__main__":
    main()
