"""Pipeline step 4 (ALIGN + STACK): put every cleaned frame on one north-up grid, then add up
each detector's frames per visit.

Why stack? One SPHEREx frame sees a given star at one narrow wavelength. Each of the six detectors
covers a wavelength range with ~17 channels, and over a visit (1-2 weeks) the target is imaged in most
of them. Averaging all frames from one detector in one visit gives a broadband-like image with much
better signal-to-noise (this is what the challenge suggests). Comparing the SAME detector between visits
avoids the "every star seems to change" trap, because each stack covers the same wavelengths.

Grid: gnomonic (TAN) projection centred on the target's 2026.0 position, 6.15"/pixel (SPHEREx native),
north up, east left, FOV x FOV. Row 0 of every output array is the SOUTH edge (FITS convention);
step 7 flips it once for the web.

Stacking: per pixel, a 3-sigma-clipped mean over frames (clipping removes cosmic rays and also anything
that is only in one frame, such as a fast asteroid; step 5 looks for those in the single frames).

Writes cache/<id>/stack.fits  (STACK cube [visit, band, y, x], band 0 = all six detectors, 1-6 = detector;
       NFRAMES cube, SATFRAC cube (fraction of frames with saturation-type flags), plus a frames table)
       out/stack/<id>.json  (visit dates, frame counts, wavelength ranges, target centroid check)
Usage:  python step4_align_stack.py --only barnard,wise0855 [--fov 0.25]
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
from scipy.ndimage import map_coordinates

warnings.simplefilter("ignore", FITSFixedWarning)
warnings.filterwarnings("ignore", message=".*SIP.*")
logging.getLogger("astropy").setLevel(logging.ERROR)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
CACHE = os.environ.get("SPHEREX_CACHE", os.path.join(HERE, "cache"))
PIX_ARCSEC = 6.15
MIN_FRAMES = 3          # a detector stack needs at least this many frames
MIN_VISIT_FRAMES = 12  # a visit needs at least this many frames to become a blink frame
MIN_COVER = 0.4         # a stacked pixel needs at least this fraction of the best-covered pixel's frames
FLATTEN = True          # subtract smooth large-scale background (turn off for extended nebulae)


def make_grid(ra, dec, fov):
    n = int(round(fov * 3600 / PIX_ARCSEC))
    n += (n + 1) % 2                                  # odd size -> target sits on the centre pixel
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]          # FITS is 1-based
    w.wcs.cdelt = [-PIX_ARCSEC / 3600, PIX_ARCSEC / 3600]   # east left, north up
    return w, n


def reproject(path, grid, n):
    """Bilinear resample of one cleaned frame onto the output grid (NaN where no data)."""
    with fits.open(path) as h:
        sci = h["SCI"].data.astype(np.float64)
        bad = h["BAD"].data.astype(bool)
        sat = h["SAT"].data.astype(bool)
        w_in = WCS(h["SCI"].header)
    yy, xx = np.mgrid[0:n, 0:n]
    ra, dec = grid.pixel_to_world_values(xx, yy)
    xi, yi = w_in.world_to_pixel_values(ra, dec)
    coords = np.array([yi, xi])
    valid = np.isfinite(sci)
    out = map_coordinates(np.where(valid, sci, 0.0), coords, order=1, mode="constant", cval=0.0)
    wgt = map_coordinates(valid.astype(float), coords, order=1, mode="constant", cval=0.0)
    out = np.where(wgt > 0.75, out / np.maximum(wgt, 1e-9), np.nan)     # need 75% real data under the pixel
    badm = map_coordinates(bad.astype(float), coords, order=0, mode="constant", cval=1.0) > 0.5
    satm = map_coordinates(sat.astype(float), coords, order=0, mode="constant", cval=0.0) > 0.5
    return out.astype(np.float32), badm, satm


def clipped_mean(cube, nsig=3.0, iters=3):
    """Per-pixel 3-sigma-clipped mean over frames. Pixels with no data in any frame stay NaN (silently)."""
    c = cube.copy()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)      # all-NaN pixels outside the footprint
        for _ in range(iters):
            med = np.nanmedian(c, axis=0)
            mad = 1.4826 * np.nanmedian(np.abs(c - med), axis=0)
            c = np.where(np.abs(c - med) <= nsig * np.maximum(mad, 1e-6), c, np.nan)
        return np.nanmean(c, axis=0), np.sum(np.isfinite(c), axis=0)


def stack_frames(imgs):
    """Clipped mean of a list of frames, keeping only pixels covered by enough frames. Edge pixels seen
    by one or two frames are much noisier than the rest and showed up as grainy wedges."""
    if len(imgs) == 1:
        return imgs[0], np.isfinite(imgs[0]).astype(np.int16)
    m, k = clipped_mean(np.array(imgs))
    need = max(2, int(np.ceil(MIN_COVER * k.max())))
    return np.where(k >= need, m, np.nan).astype(np.float32), k


def flatten(img):
    """Remove a smooth background gradient (zodi residuals, scattered light): fit a 2nd-order
    surface to the sky pixels only (stars and halos clipped away) and subtract it. A low-order surface
    cannot imprint boxes or rings around bright stars, unlike a block-median background."""
    n = img.shape[0]
    yy, xx = np.mgrid[0:n, 0:n] / (n - 1) - 0.5
    A = np.stack([np.ones_like(xx), xx, yy, xx * yy, xx ** 2, yy ** 2], -1).reshape(-1, 6)
    z = img.reshape(-1)
    use = np.isfinite(z)
    if use.sum() < 100:
        return img
    for _ in range(5):
        coef, *_ = np.linalg.lstsq(A[use], z[use], rcond=None)
        r = z - A @ coef
        s = 1.4826 * np.nanmedian(np.abs(r[use]))
        new = np.isfinite(z) & (r < 2.5 * s) & (r > -4 * s)       # drop stars, halos (positive outliers)
        if new.sum() < 100 or (new == use).all():
            break
        use = new
    return img - (A @ coef).reshape(n, n)


def centroid(img, x0, y0, r=3):
    """Flux-weighted centroid in a small box (used to check alignment and measure motion)."""
    xi, yi = int(round(x0)), int(round(y0))
    box = img[yi - r:yi + r + 1, xi - r:xi + r + 1]
    if box.shape != (2 * r + 1, 2 * r + 1) or not np.isfinite(box).any():
        return np.nan, np.nan, np.nan
    # saturated cores are NaN in the cleaned frames; they are the brightest part of the star, so count
    # them at the box's peak instead of zero (otherwise the centroid is pulled out into the halo)
    box = np.where(np.isfinite(box), box, np.nanmax(box))
    b = box - np.nanmedian(img)
    b[b < 0] = 0
    if b.sum() <= 0:
        return np.nan, np.nan, np.nan
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
    return xi + (b * xx).sum() / b.sum(), yi + (b * yy).sum() / b.sum(), float(b.max())


def run(t, fov):
    rows = list(csv.DictReader(open(os.path.join(OUT, "clean", t["id"] + ".csv"))))
    grid, n = make_grid(t["ra"], t["dec"], fov)
    visits = sorted({int(r["visit"]) for r in rows})
    visits = [v for v in visits if sum(int(r["visit"]) == v for r in rows) >= MIN_VISIT_FRAMES]
    nv = len(visits)
    if nv == 0:
        sys.exit(f"{t['id']}: no visit has {MIN_VISIT_FRAMES}+ cleaned frames, nothing to stack")
    stack = np.full((nv, 7, n, n), np.nan, np.float32)
    nfr = np.zeros((nv, 7, n, n), np.int16)
    satf = np.zeros((nv, 7, n, n), np.float32)
    meta = []
    cdir = os.path.join(CACHE, t["id"], "clean")
    for i, v in enumerate(visits):
        vrows = [r for r in rows if int(r["visit"]) == v]
        per_det = {}
        for det in range(1, 7):
            drows = [r for r in vrows if int(r["detector"]) == det]
            imgs, sats = [], []
            for r in drows:
                try:
                    im, bad, sat = reproject(os.path.join(cdir, r["file"]), grid, n)
                except FileNotFoundError:
                    continue
                imgs.append(im); sats.append(sat)
            if len(imgs) < MIN_FRAMES:
                continue
            m, k = stack_frames(imgs)
            if FLATTEN:
                m = flatten(m)
            stack[i, det], nfr[i, det], satf[i, det] = m, k, np.mean(sats, axis=0)
            lams = [float(r["wavelength_um"]) for r in drows if r["wavelength_um"] not in ("", "nan")]
            per_det[det] = dict(n_frames=len(imgs), wavelength_um=[round(min(lams), 3), round(max(lams), 3)] if lams else None)
        dets = [d for d in range(1, 7) if d in per_det]
        if dets:
            # band 0: all six detectors added (each detector stack weighted equally, in MJy/sr)
            ncov = np.isfinite(stack[i, dets]).sum(axis=0)
            allb = np.nansum(stack[i, dets], axis=0) / np.maximum(ncov, 1)
            stack[i, 0] = np.where(ncov >= max(1, (len(dets) + 1) // 2), allb, np.nan)  # avoid coverage steps
            nfr[i, 0] = nfr[i, dets].sum(axis=0)
            satf[i, 0] = satf[i, dets].max(axis=0)
        mjds = [float(r["mjd"]) for r in vrows]
        meta.append(dict(visit=v, mjd_mean=round(float(np.mean(mjds)), 3), mjd_min=round(min(mjds), 3),
                         mjd_max=round(max(mjds), 3), n_frames=len(vrows), detectors=per_det))
    # alignment check: centroid of the target in each visit's all-detector stack, vs. predicted position
    c = (n - 1) / 2
    for i, m in enumerate(meta):
        yr = 2000 + (m["mjd_mean"] - 51544.5) / 365.25
        dt = yr - t["epoch"]
        px = c - t.get("pmra_mas", 0) * dt / 1000 / PIX_ARCSEC      # east is -x
        py = c + t.get("pmdec_mas", 0) * dt / 1000 / PIX_ARCSEC
        band = 6 if t["id"] == "wise0855" else 0
        cx, cy, peak = centroid(stack[i, band], px, py)
        m["target_predicted_px"] = [round(px, 2), round(py, 2)]
        m["target_measured_px"] = [round(cx, 2), round(cy, 2)] if np.isfinite(cx) else None
        m["offset_arcsec"] = round(float(np.hypot(cx - px, cy - py) * PIX_ARCSEC), 2) if np.isfinite(cx) else None
    hdr = grid.to_header()
    hdr["TARGET"] = t["name"]; hdr["FOV_DEG"] = fov; hdr["BANDS"] = "0=all detectors,1..6=detector"
    hl = fits.HDUList([fits.PrimaryHDU(header=hdr),
                       fits.ImageHDU(stack, hdr, name="STACK"),
                       fits.ImageHDU(nfr, hdr, name="NFRAMES"),
                       fits.ImageHDU(satf, hdr, name="SATFRAC")])
    hl.writeto(os.path.join(CACHE, t["id"], "stack.fits"), overwrite=True)
    os.makedirs(os.path.join(OUT, "stack"), exist_ok=True)
    info = dict(id=t["id"], name=t["name"], ra=t["ra"], dec=t["dec"], fov_deg=fov, size_px=n,
                pixel_scale_arcsec=PIX_ARCSEC, visits=meta)
    json.dump(info, open(os.path.join(OUT, "stack", t["id"] + ".json"), "w"), indent=1)
    offs = [m["offset_arcsec"] for m in meta]
    print(f"{t['id']}: {nv} visits stacked, grid {n}x{n}; target found within {offs} arcsec of prediction")
    return info


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only")
    ap.add_argument("--fov", type=float, default=0.25)
    ap.add_argument("--no-flatten", action="store_true", help="keep large-scale structure (nebulae)")
    a = ap.parse_args()
    global FLATTEN
    FLATTEN = not a.no_flatten
    targets = json.load(open(os.path.join(OUT, "targets.json")))
    if a.only:
        keep = a.only.split(",")
        targets = [t for t in targets if t["id"] in keep]
    for t in targets:
        run(t, a.fov)


if __name__ == "__main__":
    main()
