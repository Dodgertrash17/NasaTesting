"""Pipeline step 5 (COMPARE): find what moved or changed brightness between visits.

Inputs: step 4's cache/<id>/stack.fits (STACK[visit, band, y, x], band 0 = all detectors, 1-6 = detector)

  1. Difference images: every visit minus the first visit, for each band.
     A star that stayed put cancels; a mover leaves a black/white pair; a variable leaves a single blob.
  2. Source lists: point sources above 5 sigma in each visit's stack (band 0, plus band 5+6 for very
     cold brown dwarfs that are invisible at short wavelengths).
  3. Movers: link each source across visits and fit a straight-line motion. Anything moving faster than
     1.5"/yr with a good fit is a moving-object candidate (fast stars, brown dwarfs).
  4. Variables: aperture brightness of every source in every visit, per detector. A change of more than
     20% that is also > 5 sigma (in at least 2 detectors) is a variable-star candidate.
  5. Single-frame residuals: each cleaned frame minus its visit stack. Objects that are only there in one
     frame (asteroids, satellites, cosmic rays) show up here; step 6 checks them against known asteroids.

Writes cache/<id>/compare.fits (DIFF cube [visit, band, y, x], COLD = band 5+6 stack)
       out/compare/<id>.json (movers, variables, residual peaks, summary)
Usage:  python step5_compare.py --only barnard,wise0855
"""
import argparse
import csv
import json
import logging
import os
import sys
import warnings

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning
from scipy.ndimage import maximum_filter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from step4_align_stack import reproject  # noqa: E402

warnings.simplefilter("ignore", FITSFixedWarning)
warnings.filterwarnings("ignore", category=RuntimeWarning)
logging.getLogger("astropy").setLevel(logging.ERROR)

OUT = os.path.join(HERE, "out")
CACHE = os.environ.get("SPHEREX_CACHE", os.path.join(HERE, "cache"))
PIX = 6.15
DET_SIGMA = 5.0
MATCH_PX = 2.5            # a source can move up to 2.5 px (15") between consecutive visits
MIN_PM = 1.5              # "/yr: report anything faster as a mover
VAR_FRAC, VAR_SIG = 0.20, 5.0


def robust_sigma(a):
    v = a[np.isfinite(a)]
    return 1.4826 * np.median(np.abs(v - np.median(v))) if v.size else np.nan


def detect(img, nsig=DET_SIGMA, edge=4):
    s = robust_sigma(img)
    z = np.nan_to_num(img - np.nanmedian(img), nan=0.0)
    peaks = (z == maximum_filter(z, size=5)) & (z > nsig * s)
    ys, xs = np.nonzero(peaks)
    out = []
    n = img.shape[0]
    for y, x in zip(ys, xs):
        if not (edge <= x < n - edge and edge <= y < n - edge):
            continue
        box = z[y - 1:y + 2, x - 1:x + 2].clip(min=0)
        if box.sum() <= 0:
            continue
        yy, xx = np.mgrid[-1:2, -1:2]
        out.append(dict(x=float(x + (box * xx).sum() / box.sum()), y=float(y + (box * yy).sum() / box.sum()),
                        snr=float(z[y, x] / s)))
    return out, s


def aperture(img, x, y, r=2.0, r_in=5.0, r_out=8.0):
    n = img.shape[0]
    yy, xx = np.mgrid[0:n, 0:n]
    d = np.hypot(xx - x, yy - y)
    ap, ann = d <= r, (d >= r_in) & (d <= r_out)
    if not np.isfinite(img[ap]).all() or np.isfinite(img[ann]).sum() < 10:
        return np.nan, np.nan
    sky = np.nanmedian(img[ann])
    s = robust_sigma(img[ann])
    return float(np.sum(img[ap] - sky)), float(s * np.sqrt(ap.sum()))


def link_movers(cats, years):
    """Greedy linking: start from each source in the first visit it appears in, follow the nearest
    source in each later visit (within MATCH_PX scaled by the time gap), then fit x(t), y(t)."""
    used = [set() for _ in cats]
    tracks = []
    for v0 in range(len(cats)):
        for i0, s0 in enumerate(cats[v0]):
            if i0 in used[v0]:
                continue
            pts = [(v0, i0, s0)]
            for v in range(v0 + 1, len(cats)):
                last = pts[-1][2]
                gap = max(1.0, (years[v] - years[pts[-1][0]]) / 0.5)   # allow more motion over longer gaps
                best, bd = None, MATCH_PX * gap
                for j, s in enumerate(cats[v]):
                    if j in used[v]:
                        continue
                    d = np.hypot(s["x"] - last["x"], s["y"] - last["y"])
                    if d < bd:
                        best, bd = j, d
                if best is not None:
                    pts.append((v, best, cats[v][best]))
            for v, i, _ in pts:
                used[v].add(i)
            if len(pts) < 2:
                continue
            t = np.array([years[v] for v, _, _ in pts])
            x = np.array([p["x"] for _, _, p in pts]); y = np.array([p["y"] for _, _, p in pts])
            if np.ptp(t) < 0.3:
                continue
            A = np.vstack([np.ones_like(t), t - t.mean()]).T
            cx, *_ = np.linalg.lstsq(A, x, rcond=None); cy, *_ = np.linalg.lstsq(A, y, rcond=None)
            res = np.hypot(x - A @ cx, y - A @ cy)
            snr = np.mean([p["snr"] for _, _, p in pts])
            pos_err = max(0.15, 1.0 / snr)                                # px, rough centroid error
            pm_px = np.hypot(cx[1], cy[1])
            pm_err = pos_err * np.sqrt(2) / np.ptp(t)
            tracks.append(dict(visits=[int(v) for v, _, _ in pts], x=x.round(2).tolist(), y=y.round(2).tolist(),
                               pm_arcsec_yr=round(float(pm_px * PIX), 2), pm_err=round(float(pm_err * PIX), 2),
                               pm_ra_arcsec_yr=round(float(-cx[1] * PIX), 2),     # east = -x
                               pm_dec_arcsec_yr=round(float(cy[1] * PIX), 2),
                               fit_rms_px=round(float(res.std()), 2), snr=round(float(snr), 1)))
    return tracks


def residual_peaks(t, info, cube_by_visit_det, grid, n, nsig=8.0):
    """Peaks in (single frame - its visit/detector stack): one-frame objects such as asteroids."""
    rows = list(csv.DictReader(open(os.path.join(OUT, "clean", t["id"] + ".csv"))))
    vidx = {m["visit"]: i for i, m in enumerate(info["visits"])}
    peaks = []
    for r in rows:
        v, det = int(r["visit"]), int(r["detector"])
        if v not in vidx:
            continue
        stk = cube_by_visit_det[vidx[v], det]
        if not np.isfinite(stk).any():
            continue
        im, bad, _ = reproject(os.path.join(CACHE, t["id"], "clean", r["file"]), grid, n)
        im = np.where(bad, np.nan, im)                    # science mask: drops flagged cosmic rays
        # scale the stack to this frame (different wavelength within the detector) before subtracting
        ok = np.isfinite(im) & np.isfinite(stk) & (stk > 5 * robust_sigma(stk))
        k = np.nanmedian(im[ok] / stk[ok]) if ok.sum() > 20 else 1.0
        res = im - k * stk
        s = robust_sigma(res)
        # avoid residuals of stars (their brightness differs per wavelength): skip anything within 3 px of a
        # source in the stack, and near the edges of the frame's coverage
        starmask = maximum_filter(np.nan_to_num(stk), size=7) > 3 * robust_sigma(stk)
        starmask |= maximum_filter((~np.isfinite(im)).astype(np.uint8), size=7) > 0
        z = np.nan_to_num(res, nan=0.0)
        pk = (z == maximum_filter(z, size=5)) & (z > nsig * s) & ~starmask
        for y, x in zip(*np.nonzero(pk)):
            # a real object is a few pixels wide; a hot pixel / cosmic ray is a single sharp spike
            nb = (z[max(0, y - 1):y + 2, max(0, x - 1):x + 2] > 2.5 * s).sum()
            if nb < 3:
                continue
            ra, dec = grid.pixel_to_world_values(x, y)
            peaks.append(dict(file=r["file"], mjd=float(r["mjd"]), visit=v, detector=det, x=int(x), y=int(y),
                              ra=round(float(ra), 6), dec=round(float(dec), 6), snr=round(float(z[y, x] / s), 1)))
    return peaks


def target_matched_wavelength(t, info):
    """The strict test for the target itself: compare its brightness between visits ONLY at matching
    wavelengths (frames within 1% in wavelength), using step 3's per-frame measurements. This cannot be
    fooled by a steep spectrum (brown dwarfs) or by different channel coverage."""
    rows = [r for r in csv.DictReader(open(os.path.join(OUT, "clean", t["id"] + ".csv")))
            if r["wavelength_um"] not in ("", "nan")]
    key = "flux_ujy"
    good = lambda r: r[key] not in ("", "nan") and float(r["aperture_bad_frac"]) < 0.3 and r["saturated"] == "False"
    sat = sum(not good(r) for r in rows) > len(rows) / 2
    if sat:                                   # bright targets: use the approximate display-mask flux
        key = "flux_display_ujy"
        good = lambda r: r[key] not in ("", "nan")
    visits = [m["visit"] for m in info["visits"]]
    by_v = {v: [r for r in rows if int(r["visit"]) == v and good(r)] for v in visits}
    out = []
    ref = visits[0]
    for v in visits[1:]:
        ratios = []
        for r in by_v[v]:
            lam = float(r["wavelength_um"])
            m = [q for q in by_v[ref] if abs(float(q["wavelength_um"]) - lam) < 0.01 * lam]
            if not m:
                continue
            f0 = np.median([float(q[key]) for q in m])
            if f0 > 0 and float(r[key]) > 0:
                ratios.append((lam, float(r[key]) / f0))
        if len(ratios) < 5:
            continue
        def summ(vals):
            vals = np.array(vals)
            if len(vals) < 6:
                return None, None, 0
            med = float(np.median(vals)); err = float(1.2533 * vals.std() / np.sqrt(len(vals)))
            level = 2 if abs(med - 1) > 5 * err else (1 if abs(med - 1) > 3 * err else 0)
            return round(med, 3), round(err, 3), level if abs(med - 1) > 0.15 else 0
        allr = summ([x for _, x in ratios])
        sh = summ([x for l, x in ratios if l < 2.5]); lg = summ([x for l, x in ratios if l >= 2.5])
        out.append(dict(visit=v, vs_visit=ref, n_pairs=len(ratios), ratio=allr[0], ratio_err=allr[1],
                        ratio_below_2p5um=sh[0], err_below=sh[1], ratio_above_2p5um=lg[0], err_above=lg[1],
                        verdict=["steady", "possible change", "changed"][max(allr[2], sh[2], lg[2])],
                        significant=max(allr[2], sh[2], lg[2]) == 2, approximate=sat))
    return out


def run(t, do_residuals=True):
    sf = fits.open(os.path.join(CACHE, t["id"], "stack.fits"))
    stack = sf["STACK"].data.astype(np.float64)
    grid = WCS(sf["STACK"].header).celestial
    info = json.load(open(os.path.join(OUT, "stack", t["id"] + ".json")))
    nv, nb, n, _ = stack.shape
    years = [2000 + (m["mjd_mean"] - 51544.5) / 365.25 for m in info["visits"]]

    diff = stack - stack[0:1]                                   # each visit minus the first
    cold = np.nanmean(stack[:, 5:7], axis=1)                    # detectors 5+6 (3.8-5.0 um) for cold objects

    res = dict(id=t["id"], name=t["name"], n_visits=nv, years=[round(y, 3) for y in years])
    c = (n - 1) / 2
    satfrac = sf["SATFRAC"].data[:, 0]
    is_sat = lambda x, y: bool(np.nanmax(satfrac[:, int(round(y)) - 1:int(round(y)) + 2,
                                                 int(round(x)) - 1:int(round(x)) + 2]) > 0.3)
    for label, imgs in (("all", stack[:, 0]), ("cold", cold)):
        cats = [detect(imgs[v])[0] for v in range(nv)]
        tracks = link_movers(cats, years)
        need = min(3, nv)                       # a straight line through 2 points always fits: need 3 visits
        movers, sat_movers = [], []
        for tr in tracks:
            if not (tr["pm_arcsec_yr"] > MIN_PM and tr["pm_arcsec_yr"] > 3 * tr["pm_err"] and tr["fit_rms_px"] < 0.35
                    and len(tr["visits"]) >= need and tr["snr"] >= 10):
                continue
            # a real mover leaves its first position empty; a mislinked static star does not
            x0, y0, vl = tr["x"][0], tr["y"][0], tr["visits"][-1]
            if any(np.hypot(q["x"] - x0, q["y"] - y0) < 1.0 for q in cats[vl]):
                continue
            # ...and its last position must be empty in the first visit
            x1, y1, vf = tr["x"][-1], tr["y"][-1], tr["visits"][0]
            if any(np.hypot(q["x"] - x1, q["y"] - y1) < 1.0 for q in cats[vf]):
                continue
            tr["is_target"] = bool(min(np.hypot(np.array(tr["x"]) - c, np.array(tr["y"]) - c)) < 3)
            (sat_movers if is_sat(tr["x"][0], tr["y"][0]) else movers).append(tr)
        res[f"movers_{label}"] = sorted(movers, key=lambda m: -m["pm_arcsec_yr"])
        res[f"movers_saturated_{label}"] = sat_movers      # saturated cores: motion only approximate
        res[f"n_sources_{label}"] = [len(cc) for cc in cats]

    # variables (field): per-detector photometry of every bright source in the mean of all visits,
    # normalised by the median change of all field stars in that detector+visit (relative photometry,
    # which removes calibration or channel-coverage differences that affect every star alike).
    base = [q for q in detect(np.nanmean(stack[:, 0], axis=0))[0] if q["snr"] >= 20]
    F = np.full((len(base), 7, nv), np.nan); E = np.full_like(F, np.nan)
    for k, q in enumerate(base):
        for b in range(1, 7):
            for v in range(nv):
                F[k, b, v], E[k, b, v] = aperture(stack[v, b], q["x"], q["y"])
    with np.errstate(all="ignore"):
        rel = F / np.nanmedian(F, axis=2, keepdims=True)
        zp = np.nanmedian(rel, axis=0, keepdims=True)          # field-wide change per detector+visit
        Fn = F / zp
    variables = []
    for k, q in enumerate(base):
        per_det, strong = {}, []
        for b in range(1, 7):
            f, e = Fn[k, b], E[k, b] / zp[0, b]
            if np.isfinite(f).sum() < nv or np.nanmax(f) <= 0:
                continue
            hi, lo = int(np.nanargmax(f)), int(np.nanargmin(f))
            frac = (f[hi] - f[lo]) / f[hi]
            sig = (f[hi] - f[lo]) / np.hypot(e[hi], e[lo])
            per_det[b] = dict(flux=[round(float(x), 3) for x in f], brightest_visit=hi, faintest_visit=lo,
                              change_frac=round(float(frac), 3), change_sigma=round(float(sig), 1))
            if frac > VAR_FRAC and sig > VAR_SIG:
                strong.append(b)
        if len(strong) >= 3:
            variables.append(dict(x=round(q["x"], 2), y=round(q["y"], 2), snr=round(q["snr"], 1),
                                  is_target=bool(np.hypot(q["x"] - c, q["y"] - c) < 3),
                                  saturated=is_sat(q["x"], q["y"]), detectors=strong, per_detector=per_det))
    res["variables"] = sorted(variables, key=lambda v: (-v["is_target"], -max(d["change_frac"] for d in v["per_detector"].values())))
    res["target_variability"] = target_matched_wavelength(t, info)

    if do_residuals:
        res["residual_peaks"] = residual_peaks(t, info, stack, grid, n)
    hdr = sf["STACK"].header
    fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(diff.astype(np.float32), hdr, name="DIFF"),
                  fits.ImageHDU(cold.astype(np.float32), hdr, name="COLD")]).writeto(
        os.path.join(CACHE, t["id"], "compare.fits"), overwrite=True)
    os.makedirs(os.path.join(OUT, "compare"), exist_ok=True)
    json.dump(res, open(os.path.join(OUT, "compare", t["id"] + ".json"), "w"), indent=1)
    tm = [m for m in res["movers_all"] + res["movers_cold"] + res["movers_saturated_all"] if m["is_target"]]
    tv = [v for v in res["target_variability"] if v["significant"]]
    print(f"{t['id']}: movers {len(res['movers_all'])} (+{len(res['movers_cold'])} cold), "
          f"target moving: {tm[0]['pm_arcsec_yr'] if tm else '-'}\"/yr; variables {len(variables)}, "
          f"target variable: {'yes' if tv else 'no'}; one-frame peaks {len(res.get('residual_peaks', []))}")
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only")
    ap.add_argument("--no-residuals", action="store_true")
    a = ap.parse_args()
    targets = json.load(open(os.path.join(OUT, "targets.json")))
    if a.only:
        keep = a.only.split(",")
        targets = [t for t in targets if t["id"] in keep]
    for t in targets:
        run(t, not a.no_residuals)


if __name__ == "__main__":
    main()
