"""Pipeline step 1 (QUERY), part B: list every SPHEREx image covering each target.

For each target in out/targets.json, asks IRSA's SPHEREx ObsCore table which Level-2 spectral images
contain the target's (2026.0) position, then groups them into "visits" (SPHEREx passes over a spot
for a week or two every ~6 months; gaps > 20 days start a new visit).

Output: out/inventory/<id>.csv (one row per image) and out/inventory_summary.json
Usage:  python step1_inventory.py [--workers 6] [--only barnard,rdra]
"""
import argparse
import csv
import json
import os
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

import sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from irsa import spherex_images_at

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
VISIT_GAP_DAYS = 20.0
CUTOUT_MB = 5.3   # measured: a 0.1-0.25 deg IRSA cutout is ~5 MB, mostly the PSF cube


def visits(mjds):
    """Assign a visit number (0, 1, 2...) to each sorted MJD."""
    out, v, prev = [], 0, None
    for m in mjds:
        if prev is not None and m - prev > VISIT_GAP_DAYS:
            v += 1
        out.append(v)
        prev = m
    return out


def one(t):
    rows = spherex_images_at(t["ra"], t["dec"])
    vis = visits([r["t_min"] for r in rows])
    path = os.path.join(OUT, "inventory", t["id"] + ".csv")
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["obs_id", "release", "mjd", "visit", "detector", "em_min_um", "em_max_um", "access_url"])
        for r, v in zip(rows, vis):
            w.writerow([r["obs_id"], r["obs_collection"].replace("spherex_", ""), f"{r['t_min']:.5f}", v,
                        r["detector"], f"{r['em_min_um']:.4f}", f"{r['em_max_um']:.4f}", r["access_url"]])
    per_visit = []
    for v in sorted(set(vis)):
        sel = [r for r, vv in zip(rows, vis) if vv == v]
        per_visit.append(dict(visit=v, mjd_start=round(sel[0]["t_min"], 2), mjd_end=round(sel[-1]["t_min"], 2),
                              n=len(sel), per_detector=dict(sorted(Counter(r["detector"] for r in sel).items()))))
    return dict(id=t["id"], name=t["name"], kind=t["kind"], n_images=len(rows), n_visits=len(per_visit),
                releases=dict(Counter(r["obs_collection"] for r in rows)), visits=per_visit,
                est_download_mb=round(len(rows) * CUTOUT_MB))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--only")
    a = ap.parse_args()
    targets = json.load(open(os.path.join(OUT, "targets.json")))
    if a.only:
        keep = set(a.only.split(","))
        targets = [t for t in targets if t["id"] in keep]
    os.makedirs(os.path.join(OUT, "inventory"), exist_ok=True)
    with ThreadPoolExecutor(a.workers) as ex:
        res = list(ex.map(one, targets))
    json.dump(res, open(os.path.join(OUT, "inventory_summary.json"), "w"), indent=1)
    tot = sum(r["n_images"] for r in res)
    print(f"{len(res)} targets, {tot} images, ~{tot * CUTOUT_MB / 1024:.0f} GB as cutouts")
    for r in res:
        print(f"{r['id']:18s} {r['n_images']:4d} images  {r['n_visits']} visits")


if __name__ == "__main__":
    main()
