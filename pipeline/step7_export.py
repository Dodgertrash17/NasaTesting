"""Pipeline step 7 (EXPORT): turn the pipeline's results into the files the website reads
(contract: public/data/README.md in the NasaTesting repo).

For each target:
  Viewer   data/<id>.json + data/frames/<id>/vNN_<det>.png (+ _flags.png)
           One frame per visit per detector ("all" = six detectors added, 1..6 = one detector), all on
           the same 6.15"/px north-up grid from step 4, flipped once so row 0 is NORTH (web convention).
           8-bit asinh stretch, the same for every visit of a detector, so blinking compares like with like.
           light_curve = the target's real aperture photometry from step 3 (microJansky per detector,
           relative for the all-detector frames, from step 5's matched-wavelength comparison).
           overlays = the target's Gaia DR3 / CatWISE2020 catalogue positions (at their own epochs).
           predictions = step 6 movers (confirmed / unconfirmed) and step 5 brightness changes.
  Dome     data/dome/cubes/<id>/eNN.png: per visit, 17 x 6 grid of 32 px tiles (row = detector, column =
           channel), each tile = the frames whose wavelength falls in that band, averaged.
           poi entry: real 102-band spectrum (max = 1), one epoch per visit with brightness vs the first visit.

The lists the site reads (patches.json, gallery.json, dome/poi.json) are merged: entries for the exported
targets are replaced or added, everything else is kept. Pass --site <public/data> to merge into the
site's current lists; output goes to out/web/data/ (copy that folder over public/data/).

Usage:  python step7_export.py --only barnard,wise0855 --site path/to/public/data
"""
import argparse
import csv
import json
import math
import os
import shutil
import sys
import warnings

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning
from PIL import Image

warnings.simplefilter("ignore", FITSFixedWarning)
warnings.filterwarnings("ignore", category=RuntimeWarning)
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from irsa import tap  # noqa: E402
from step4_align_stack import make_grid, reproject  # noqa: E402

OUT = os.path.join(HERE, "out")
CACHE = os.environ.get("SPHEREX_CACHE", os.path.join(HERE, "cache"))
PIX = 6.15
TILE = 32
DET_NAME = {0: "all"}
CATEGORY = {"star": "star", "variable": "variable", "brown-dwarf": "brown-dwarf"}


def mjd_to_year(mjd):
    return 2000 + (mjd - 51544.5) / 365.25


def asinh_scale(values):
    """Stretch for a set of images: black at the sky level, soft knee a few noise units up."""
    v = values[np.isfinite(values)]
    if v.size == 0:
        return 0.0, 1.0, 1.0
    sky = float(np.median(v))
    noise = float(1.4826 * np.median(np.abs(v - sky))) or 1e-3
    hi = float(np.percentile(v, 99.9))
    return sky - 1.0 * noise, max(hi, sky + 20 * noise), 2.0 * noise


def to_u8(img, lo, hi, soft):
    x = np.clip((img - lo) / soft, 0, None)
    y = np.arcsinh(x) / np.arcsinh((hi - lo) / soft)
    y = np.where(np.isfinite(y), y, 0.0)
    return (np.clip(y, 0, 1) * 255 + 0.5).astype(np.uint8)


def save_png(arr, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.fromarray(arr, mode="L").save(path, optimize=True)


def robust(vals):
    v = np.array([x for x in vals if np.isfinite(x)])
    if v.size == 0:
        return None, None
    med = float(np.median(v))
    err = float(1.4826 * np.median(np.abs(v - med)) / math.sqrt(v.size)) if v.size > 1 else None
    return med, err


# ---------------------------------------------------------------- catalogue overlays
def target_overlays(t):
    gaia, wise = [], []
    if t.get("position_source") == "Gaia DR3":
        gaia.append(dict(ra=round(t["ra_cat"], 6), dec=round(t["dec_cat"], 6), label=t["catalog_id"], epoch=2016.0))
    # CatWISE2020: the nearest bright W2 source to where the target was in ~2015
    ep = 2015.4
    cosd = math.cos(math.radians(t["dec"]))
    ra_e = t["ra"] + t.get("pmra_mas", 0) * (ep - t["epoch"]) / 3.6e6 / cosd
    de_e = t["dec"] + t.get("pmdec_mas", 0) * (ep - t["epoch"]) / 3.6e6
    try:
        rows = tap("SELECT source_name, ra, dec, w2mpro, meanobsmjd FROM catwise_2020 WHERE "
                   f"CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',{ra_e},{de_e},{15 / 3600}))=1")
    except Exception:  # noqa: BLE001
        rows = []
    rows = [r for r in rows if r.get("w2mpro") not in (None, "")]
    if rows:
        r = min(rows, key=lambda r: float(r["w2mpro"]))
        wise.append(dict(ra=round(float(r["ra"]), 6), dec=round(float(r["dec"]), 6), label="CWISE " + r["source_name"].strip(),
                         epoch=round(mjd_to_year(float(r["meanobsmjd"])), 2)))
    return dict(gaia=gaia, wise=wise)


# ---------------------------------------------------------------- viewer patch
def export_patch(t, web, overlays):
    tid = t["id"]
    info = json.load(open(os.path.join(OUT, "stack", tid + ".json")))
    comp = json.load(open(os.path.join(OUT, "compare", tid + ".json")))
    ident = json.load(open(os.path.join(OUT, "identify", tid + ".json")))
    rows = list(csv.DictReader(open(os.path.join(OUT, "clean", tid + ".csv"))))
    with fits.open(os.path.join(CACHE, tid, "stack.fits")) as h:
        stack, satf, nfr = h["STACK"].data, h["SATFRAC"].data, h["NFRAMES"].data
    nv, nb, n, _ = stack.shape
    flip = lambda a: a[::-1]          # row 0 = south (FITS)  ->  row 0 = north (web)
    fy = lambda y: round((n - 1) - y, 2)
    fdir = os.path.join(web, "frames", tid)
    shutil.rmtree(fdir, ignore_errors=True)
    scales = {b: asinh_scale(stack[:, b]) for b in range(nb)}
    vis_of = {m["visit"]: i for i, m in enumerate(info["visits"])}

    frames, lc, used = [], [], set()
    for i, vm in enumerate(info["visits"]):
        vrows = [r for r in rows if vis_of.get(int(r["visit"])) == i]
        for b in range(nb):
            img = stack[i, b]
            if not np.isfinite(img).any():
                continue
            det = "all" if b == 0 else b
            drows = vrows if b == 0 else [r for r in vrows if int(r["detector"]) == b]
            if b > 0 and str(b) not in vm["detectors"]:
                continue
            mjd = vm["mjd_mean"] if b == 0 else round(float(np.mean([float(r["mjd"]) for r in drows])), 3)
            while any(abs(mjd - u) < 0.012 for u in used):     # the viewer matches light-curve rows by date
                mjd = round(mjd + 0.012, 3)
            used.add(mjd)
            name = f"v{i:02d}_{det}"
            save_png(to_u8(flip(img), *scales[b]), os.path.join(fdir, name + ".png"))
            sat = flip(satf[i, b] > 0.25)
            nodata = flip(~np.isfinite(img))
            save_png(np.where(sat | nodata, 255, 0).astype(np.uint8), os.path.join(fdir, name + "_flags.png"))
            if b == 0:
                band = "All 6 detectors added"
                wl = [min(d["wavelength_um"][0] for d in vm["detectors"].values() if d["wavelength_um"]),
                      max(d["wavelength_um"][1] for d in vm["detectors"].values() if d["wavelength_um"])]
            else:
                wl = vm["detectors"][str(b)]["wavelength_um"]
                band = f"Detector {b}, its ~17 channels stacked"
            nsat = sum(r["saturated"] == "True" for r in drows)
            notes = [f"{len(drows)} exposures between {mjd_to_date(vm['mjd_min'])} and {mjd_to_date(vm['mjd_max'])}"]
            if nsat:
                notes.append(f"target saturated in {nsat} of {len(drows)} exposures (brightness approximate)")
            frames.append(dict(file=f"frames/{tid}/{name}.png", flags_file=f"frames/{tid}/{name}_flags.png", mjd=mjd,
                               band=band, detector=det, wavelength_um=wl, n_exposures=len(drows), flags=notes,
                               flag_bits={"SATURATED": int(sat.sum()), "NO_DATA": int(nodata.sum())}))
            # light curve point for the target
            if b == 0:
                if i == 0:
                    lc.append(dict(mjd=mjd, flux=1.0, err=0.0, flagged=nsat > 0, unit="relative to first visit"))
                else:
                    tv = next((x for x in comp.get("target_variability", []) if x["visit"] == i and x["vs_visit"] == 0), None)
                    if tv and tv.get("ratio") is not None:
                        lc.append(dict(mjd=mjd, flux=tv["ratio"], err=tv["ratio_err"], flagged=bool(tv.get("approximate")),
                                       unit="relative to first visit"))
            else:
                good = [float(r["flux_ujy"]) for r in drows if r["saturated"] != "True" and float(r["aperture_bad_frac"]) < 0.3]
                flagged = len(good) < max(2, len(drows) // 2)
                if flagged:
                    good = [float(r["flux_display_ujy"]) for r in drows]
                f, e = robust(good)
                if f is not None:
                    lc.append(dict(mjd=mjd, flux=round(f, 2), err=round(e, 2) if e else None, flagged=flagged, unit="uJy"))

    # predictions: movers (step 6) and brightness changes (step 5). track[].epoch = index in frames[]
    def track_for(visits, xs, ys):
        out = []
        for fi, fr in enumerate(frames):
            vi = int(fr["file"].split("/")[-1][1:3])
            if vi in visits:
                k = visits.index(vi)
                out.append(dict(epoch=fi, x=round(xs[k], 2), y=fy(ys[k])))
        return out

    preds = []
    for m in ident["movers"]:
        conf = m["status"] == "confirmed"
        label = t["name"] if m.get("is_target") else (m["match"]["id"] if conf else f"Candidate {len(preds) + 1}")
        kind = (f"Moving star, confirmed by {m['match']['catalog']} ({m['match']['catalog_pm_arcsec_yr']}″/yr)" if conf
                else "Possible mover, no catalogue match (likely an artefact)")
        preds.append(dict(id=f"M{len(preds)}", label=label, kind=kind, confidence=0.97 if conf else 0.15,
                          pm_arcsec_yr=m["pm_arcsec_yr"], track=track_for(m["visits"], m["x"], m["y"])))
    for v in comp.get("variables", []):
        ch = sorted(v["per_detector"].items(), key=lambda kv: -kv[1]["change_frac"])[0]
        label = t["name"] if v.get("is_target") else f"Variable {len(preds) + 1}"
        preds.append(dict(id=f"V{len(preds)}", label=label,
                          kind=f"Brightness changed (up to {round(100 * ch[1]['change_frac'])}% in detector {ch[0]})",
                          confidence=0.9, track=track_for(list(range(nv)), [v["x"]] * nv, [v["y"]] * nv)))

    patch = dict(id=tid, name=t["name"], width_px=n, height_px=n, ra=round(t["ra"], 6), dec=round(t["dec"], 6),
                 fov_deg=info["fov_deg"], pixel_scale_arcsec=PIX, simulated=False, grid_epoch=t["epoch"],
                 source="SPHEREx Level 2 images (IRSA), processed by pipeline steps 1-7")
    pipeline = dict(asteroids_named=len(ident["asteroids"]), asteroids_predicted_in_field=len(ident["asteroids_predicted_in_field"]),
                    one_frame_unidentified=ident["unidentified_one_frame"],
                    target_verdicts=[dict(visit=x["visit"], vs_visit=x["vs_visit"], verdict=x["verdict"]) for x in comp.get("target_variability", [])])
    doc = dict(patch=patch, frames=frames, light_curve=lc, overlays=overlays, predictions=preds, pipeline=pipeline)
    json.dump(doc, open(os.path.join(web, tid + ".json"), "w"), indent=1)
    thumb_det = "6" if tid == "wise0855" else "all"
    thumb = next((f["file"] for f in frames if str(f["detector"]) == thumb_det), frames[0]["file"])
    return doc, "data/" + thumb


def mjd_to_date(mjd):
    from datetime import datetime, timedelta
    return (datetime(1858, 11, 17) + timedelta(days=mjd)).strftime("%Y-%m-%d")


# ---------------------------------------------------------------- dome cubes + spectrum
def export_dome(t, web, bands):
    tid = t["id"]
    info = json.load(open(os.path.join(OUT, "stack", tid + ".json")))
    comp = json.load(open(os.path.join(OUT, "compare", tid + ".json")))
    rows = list(csv.DictReader(open(os.path.join(OUT, "clean", tid + ".csv"))))
    by_det = {d: sorted([b for b in bands if b["detector"] == d], key=lambda b: b["channel"]) for d in range(1, 7)}

    def band_of(det, lam):
        bs = by_det[det]
        b = min(bs, key=lambda b: abs(b["center_um"] - lam))
        return b["index"]

    vis_of = {m["visit"]: i for i, m in enumerate(info["visits"])}
    cdir = os.path.join(CACHE, tid, "clean")
    tiles = {}                                  # (visit_i, band) -> list of 32x32 images
    spec = {}                                   # band -> list of target fluxes
    for r in rows:
        vi = vis_of.get(int(r["visit"]))
        lam = float(r["wavelength_um"]) if r["wavelength_um"] not in ("", "nan") else float("nan")
        if vi is None or not np.isfinite(lam):
            continue
        bi = band_of(int(r["detector"]), lam)
        fx = float(r["flux_ujy"]) if r["saturated"] != "True" and float(r["aperture_bad_frac"]) < 0.3 else float(r["flux_display_ujy"])
        spec.setdefault(bi, []).append(fx)
        yr = mjd_to_year(float(r["mjd"]))
        cosd = math.cos(math.radians(t["dec"]))
        ra = t["ra"] + t.get("pmra_mas", 0) * (yr - t["epoch"]) / 3.6e6 / cosd
        de = t["dec"] + t.get("pmdec_mas", 0) * (yr - t["epoch"]) / 3.6e6
        grid, _ = make_grid(ra, de, TILE * PIX / 3600)
        grid.wcs.crpix = [(TILE + 1) / 2, (TILE + 1) / 2]
        try:
            im, _, _ = reproject(os.path.join(cdir, r["file"]), grid, TILE)
        except FileNotFoundError:
            continue
        tiles.setdefault((vi, bi), []).append(im)
    # one stretch per detector row, shared by every visit
    mean = {k: np.nanmean(np.array(v), axis=0) for k, v in tiles.items()}
    scale = {}
    for d in range(1, 7):
        ims = [m for (vi, bi), m in mean.items() if bands[bi]["detector"] == d]
        scale[d] = asinh_scale(np.array(ims)) if ims else (0, 1, 1)
    cube_dir = os.path.join(web, "dome", "cubes", tid)
    shutil.rmtree(cube_dir, ignore_errors=True)
    epochs = []
    ratio = {0: 1.0}
    for x in comp.get("target_variability", []):
        if x["vs_visit"] == 0 and x.get("ratio") is not None:      # None = no matched-wavelength pairs
            ratio[x["visit"]] = x["ratio"]
    for vi, vm in enumerate(info["visits"]):
        canvas = np.zeros((6 * TILE, 17 * TILE), np.uint8)
        for b in bands:
            m = mean.get((vi, b["index"]))
            if m is None:
                continue
            y0, x0 = (b["detector"] - 1) * TILE, b["channel"] * TILE
            canvas[y0:y0 + TILE, x0:x0 + TILE] = to_u8(m[::-1], *scale[b["detector"]])
        path = os.path.join(cube_dir, f"e{vi:02d}.png")
        save_png(canvas, path)
        epochs.append(dict(mjd=vm["mjd_mean"], cube=f"dome/cubes/{tid}/e{vi:02d}.png",
                           brightness=round(ratio.get(vi, 1.0), 3)))
    # spectrum: median flux per band, gaps filled by interpolation, max = 1
    med = np.full(len(bands), np.nan)
    for bi, v in spec.items():
        v = np.array(v)
        v = v[np.isfinite(v)]
        if v.size:
            med[bi] = np.median(v)
    measured = np.isfinite(med)
    lam = np.array([b["center_um"] for b in bands])
    if measured.sum() >= 2:
        med = np.interp(lam, lam[measured], med[measured])
    med = np.clip(np.nan_to_num(med), 0, None)
    spectrum = [round(float(x), 4) for x in (med / med.max() if med.max() > 0 else med)]
    return spectrum, epochs, int(measured.sum())


# ---------------------------------------------------------------- merge the site lists
def load_list(site, rel, default):
    p = os.path.join(site, rel) if site else None
    return json.load(open(p)) if p and os.path.exists(p) else default


def export_one(t, web, bands, no_dome):
    """Everything for one target; returns what the shared lists need. Saved to out/web/results/<id>.json
    so a rerun with --reuse only rebuilds the lists."""
    ov = target_overlays(t)
    doc, thumb = export_patch(t, web, ov)
    r = dict(id=t["id"], fov=doc["patch"]["fov_deg"], thumb=thumb, frames=len(doc["frames"]), lc=len(doc["light_curve"]),
             preds=len(doc["predictions"]), gaia=len(ov["gaia"]), wise=len(ov["wise"]))
    if bands and not no_dome:
        r["spectrum"], r["epochs"], r["nmeas"] = export_dome(t, web, bands)
    os.makedirs(os.path.join(OUT, "web", "results"), exist_ok=True)
    json.dump(r, open(os.path.join(OUT, "web", "results", t["id"] + ".json"), "w"))
    return r


def _safe_export(args):
    t = args[0]
    try:
        return export_one(*args)
    except Exception as e:  # noqa: BLE001
        print(f"{t['id']}: export FAILED: {e}", flush=True)
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only")
    ap.add_argument("--site", help="the site's current public/data folder (lists are merged from it)")
    ap.add_argument("--no-dome", action="store_true")
    ap.add_argument("--workers", type=int, default=4, help="targets exported in parallel")
    ap.add_argument("--reuse", action="store_true", help="skip targets already exported (out/web/results/<id>.json)")
    a = ap.parse_args()
    targets = json.load(open(os.path.join(OUT, "targets.json")))
    if a.only:
        keep = a.only.split(",")
        targets = [t for t in targets if t["id"] in keep]
    web = os.path.join(OUT, "web", "data")
    os.makedirs(web, exist_ok=True)
    patches = load_list(a.site, "patches.json", [])
    gallery = load_list(a.site, "gallery.json", [])
    poi = load_list(a.site, "dome/poi.json", dict(categories={}, pois=[]))
    bands = load_list(a.site, "dome/bands.json", None)
    bands = bands["bands"] if bands else None
    res_dir = os.path.join(OUT, "web", "results")
    results, todo = {}, []
    for t in targets:
        rp = os.path.join(res_dir, t["id"] + ".json")
        if a.reuse and os.path.exists(rp):
            results[t["id"]] = json.load(open(rp))
        else:
            todo.append(t)
    from concurrent.futures import ProcessPoolExecutor
    with ProcessPoolExecutor(a.workers) as ex:
        for t, r in zip(todo, ex.map(_safe_export, [(t, web, bands, a.no_dome) for t in todo])):
            if r:
                results[t["id"]] = r
                msg = f"{t['id']}: {r['frames']} frames, {r['lc']} light-curve points, {r['preds']} predictions, " \
                      f"overlays gaia {r['gaia']} / wise {r['wise']}"
                if "epochs" in r:
                    msg += f"; dome: {len(r['epochs'])} cubes, {r['nmeas']}/102 bands measured"
                print(msg, flush=True)
    for t in targets:
        r = results.get(t["id"])
        if not r:
            continue
        entry = dict(id=t["id"], title=t["name"], ra=round(t["ra"], 6), dec=round(t["dec"], 6), fov_deg=r["fov"])
        patches = [p for p in patches if p["id"] != t["id"]] + [entry]
        g = next((g for g in gallery if g["id"] == t["id"]), None)
        if g is None:
            g = dict(id=t["id"], name=t["name"], type=t["kind"], blurb=t.get("subtype", ""))
            gallery.append(g)
        g.update(ra=round(t["ra"], 6), dec=round(t["dec"], 6), fov=r["fov"], thumb=r["thumb"], status="ready")
        if "epochs" in r:
            p = next((p for p in poi["pois"] if p["id"] == t["id"]), None)
            if p is None:
                p = dict(id=t["id"], name=t["name"], category=CATEGORY.get(t["kind"], "star"), type=t.get("subtype", ""),
                         size=3, blurb=t.get("subtype", ""))
                poi["pois"].append(p)
            p.update(ra=round(t["ra"], 6), dec=round(t["dec"], 6), patch=t["id"], spectrum=r["spectrum"], epochs=r["epochs"],
                     simulated=False, spectrum_source=f"SPHEREx aperture photometry, {r['nmeas']} of 102 bands measured")
    json.dump(patches, open(os.path.join(web, "patches.json"), "w"), indent=1)
    json.dump(gallery, open(os.path.join(web, "gallery.json"), "w"), indent=1)
    if bands and not a.no_dome:
        os.makedirs(os.path.join(web, "dome"), exist_ok=True)
        json.dump(poi, open(os.path.join(web, "dome", "poi.json"), "w"), indent=1)
    print(f"lists written: {len(results)} targets", flush=True)


if __name__ == "__main__":
    main()
