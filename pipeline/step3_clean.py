"""Pipeline step 3 (CLEAN): turn each downloaded SPHEREx cutout into a clean, calibrated frame.

For every image of a target (from step 2's cache/<id>/manifest.csv):
  1. subtract the ZODI layer (the pipeline's model of zodiacal light, the glow of solar-system dust)
  2. mask bad pixels using the FLAGS bitmask, following IRSA's own mosaic recipe (Explanatory
     Supplement v2.0, sec. 3.4.3). Bit 21 SOURCE marks real stars and is never masked. Two masks are kept:
     a strict SCIENCE mask for brightness measurements, and a light DISPLAY mask so bright stars, whose
     centres trip saturation-type flags, still show in the pictures (and are labelled "saturated").
  3. remove what is left of the sky level (sigma-clipped median), estimate the noise
  4. record the wavelength the target was seen at (SPHEREx's filter changes across the detector:
     the WCS-WAVE table gives the wavelength at every pixel)
  5. measure the target's flux in a small aperture (for spectra and light curves later)

Writes cache/<id>/clean/<file> (extensions SCI, ERR, BAD, SAT, same WCS) and out/clean/<id>.csv
Usage:  python step3_clean.py --only barnard,wise0855
"""
import argparse
import csv
import json
import os
import sys
import warnings

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning

warnings.simplefilter("ignore", FITSFixedWarning)
warnings.filterwarnings("ignore", message=".*SIP.*")
import logging
logging.getLogger("astropy").setLevel(logging.ERROR)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
CACHE = os.environ.get("SPHEREX_CACHE", os.path.join(HERE, "cache"))

# FLAGS bits (SPHEREx Explanatory Supplement v2.0, Table 16; older files only use bits 0-21)
BITS = dict(TRANSIENT=0, OVERFLOW=1, SUR_ERROR=2, PHANTOM=4, REFERENCE=5, NONFUNC=6, DICHROIC=7,
            MISSING_DATA=9, HOT=10, COLD=11, FULLSAMPLE=12, PHANMISS=14, NONLINEAR=15, PERSIST=17,
            OUTLIER=19, CROSSTALK=20, SOURCE=21, GHOST=22, GHOST_FPA=23, GHOST_EXT=24, STREAK=25,
            BLOOM=26, SNOWBALL=27, HALO=28, SATELLITE_HALO=29)
# SCIENCE mask = exactly the list IRSA's own mosaic tool masks (Expl. Suppl. sec. 3.4.3).
# OVERFLOW (half full-well; the slope before it is still valid), OUTLIER and SOURCE are kept.
SCIENCE_BAD = ["TRANSIENT", "SUR_ERROR", "NONFUNC", "DICHROIC", "MISSING_DATA", "HOT", "COLD", "PHANMISS",
               "NONLINEAR", "PERSIST", "CROSSTALK", "GHOST", "GHOST_FPA", "GHOST_EXT", "STREAK", "BLOOM",
               "SNOWBALL", "HALO", "SATELLITE_HALO"]
# DISPLAY mask = only pixels that hold no usable signal at all. Bright stars (whose cores trip
# TRANSIENT/SUR_ERROR/NONLINEAR) stay visible in the pictures; they are labelled "saturated" instead.
DISPLAY_BAD = ["NONFUNC", "DICHROIC", "MISSING_DATA", "HOT", "COLD", "PHANMISS"]
SAT_BITS = ["NONLINEAR", "BLOOM"]   # plus "early" transient/overflow (with SUR_ERROR), see clean_one
REPORT_BITS = ["TRANSIENT", "OVERFLOW", "SUR_ERROR", "NONLINEAR", "PERSIST", "OUTLIER", "GHOST", "STREAK",
               "HALO", "SOURCE"]
mask_of = lambda names: sum(1 << BITS[b] for b in names)
SCIENCE_MASK, DISPLAY_MASK, SAT_MASK = mask_of(SCIENCE_BAD), mask_of(DISPLAY_BAD), mask_of(SAT_BITS)
PIX_SR = (6.15 / 206264.806) ** 2          # one SPHEREx pixel in steradians
MJYSR_TO_UJY = PIX_SR * 1e12               # MJy/sr * sr -> MJy -> microJansky


def position_at(t, mjd):
    """Target position at the image's date (proper motion applied from the 2026.0 position)."""
    yr = 2000.0 + (mjd - 51544.5) / 365.25
    dt = yr - t["epoch"]
    dec = t["dec"] + t.get("pmdec_mas", 0) * dt / 3.6e6
    ra = t["ra"] + t.get("pmra_mas", 0) * dt / 3.6e6 / np.cos(np.radians(t["dec"]))
    return ra, dec


def sigma_clip_stats(v, n=3, it=5):
    v = v[np.isfinite(v)]
    for _ in range(it):
        if v.size < 10:
            break
        m, s = np.median(v), 1.4826 * np.median(np.abs(v - np.median(v)))
        v = v[np.abs(v - m) < n * s]
    return float(np.median(v)), float(1.4826 * np.median(np.abs(v - np.median(v))))


def aperture(sci, err, bad, x, y, r=2.0, r_in=5.0, r_out=8.0):
    yy, xx = np.indices(sci.shape)
    d = np.hypot(xx - x, yy - y)
    ap = d <= r
    ann = (d >= r_in) & (d <= r_out) & ~bad & np.isfinite(sci)
    if not ap.any() or ann.sum() < 10:
        return np.nan, np.nan, 1.0
    sky = np.median(sci[ann])
    good = ap & ~bad & np.isfinite(sci)
    frac_bad = 1 - good.sum() / ap.sum()
    if not good.any():
        return np.nan, np.nan, 1.0
    flux = np.nansum((sci - sky)[good]) * ap.sum() / max(good.sum(), 1)
    e = np.sqrt(np.nansum(err[good] ** 2)) if good.any() else np.nan
    return flux * MJYSR_TO_UJY, e * MJYSR_TO_UJY, frac_bad


def clean_one(path, t, row):
    with fits.open(path) as h:
        img = h["IMAGE"].data.astype(np.float32)
        zodi = h["ZODI"].data.astype(np.float32)
        zodi_missing = not np.isfinite(zodi).any()     # some early (May 2025) deep-field files have no zodi model
        zodi = np.where(np.isfinite(zodi), zodi, 0.0)    # the sky-level step below removes the zodi light anyway
        var = h["VARIANCE"].data.astype(np.float32)
        flags = h["FLAGS"].data.astype(np.int64)
        hdr = h["IMAGE"].header
        wcs = WCS(hdr)
        wwave = WCS(hdr, fobj=h, key="W")
        bad = ((flags & SCIENCE_MASK) != 0) | ~np.isfinite(img)        # science (photometry) mask
        dbad = ((flags & DISPLAY_MASK) != 0) | ~np.isfinite(img)       # display mask (much smaller)
        sat = (flags & SAT_MASK) != 0
        sci = img - zodi
        bg_pix = ~bad & ((flags & (1 << BITS["SOURCE"])) == 0)
        if bg_pix.sum() < 200:      # some early deep-field files flag SOURCE on every pixel
            bg_pix = ~bad
        sky, noise = sigma_clip_stats(sci[bg_pix])
        sci = sci - sky
        sci[dbad] = np.nan
        err = np.sqrt(np.clip(var, 0, None))
        ra, dec = position_at(t, float(row["mjd"]))
        x, y = (float(v) for v in wcs.world_to_pixel_values(ra, dec))
        inside = 0 <= x < sci.shape[1] and 0 <= y < sci.shape[0]
        if inside:
            lam, bw = (float(v) for v in wwave.pixel_to_world_values(x, y))
            flux, ferr, fbad = aperture(sci, err, bad, x, y)
            # bright/saturated targets: also measure with only the light display mask (approximate,
            # uses the pipeline's early-frame slope in saturated pixels). Good for relative changes only.
            flux_d, _, _ = aperture(sci, err, dbad, x, y)
            xi, yi = int(round(x)), int(round(y))
            core = (slice(max(0, yi - 1), yi + 2), slice(max(0, xi - 1), xi + 2))
            fc = flags[core]
            early = ((fc & mask_of(["SUR_ERROR"])) != 0) & ((fc & mask_of(["TRANSIENT", "OVERFLOW"])) != 0)
            sat_t = bool(sat[core].any() or early.any())   # saturated = non-linear, blooming or early overflow
        else:
            lam = bw = flux = ferr = flux_d = np.nan
            fbad, sat_t = 1.0, False
        whdr = wcs.to_header(relax=True)
        for k in ("DETECTOR", "OBSID", "MJD-OBS", "DATE-OBS", "BUNIT", "EXPTIME"):
            if k in hdr:
                whdr[k] = hdr[k]
        out = fits.HDUList([fits.PrimaryHDU(),
                            fits.ImageHDU(sci.astype(np.float32), whdr, name="SCI"),
                            fits.ImageHDU(err.astype(np.float32), whdr, name="ERR"),
                            fits.ImageHDU((bad & ~dbad).astype(np.uint8), whdr, name="BAD"),  # 1 = keep for display, skip for photometry
                            fits.ImageHDU(sat.astype(np.uint8), whdr, name="SAT")])
    flag_counts = {b: int(((flags >> BITS[b]) & 1).sum()) for b in REPORT_BITS}
    return out, dict(file=row["file"], obs_id=row["obs_id"], mjd=row["mjd"], visit=row["visit"],
                     detector=row["detector"], x=round(x, 2), y=round(y, 2), wavelength_um=round(lam, 4),
                     bandwidth_um=round(bw, 4), zodi_missing=zodi_missing, sky_mjysr=round(sky, 4), noise_mjysr=round(noise, 4),
                     flux_ujy=round(flux, 2), flux_err_ujy=round(ferr, 2),
                     flux_display_ujy=round(flux_d, 2), aperture_bad_frac=round(fbad, 2),
                     saturated=sat_t, bad_frac=round(float(bad.mean()), 4),
                     flag_counts=json.dumps(flag_counts))


def run(t):
    d = os.path.join(CACHE, t["id"])
    rows = list(csv.DictReader(open(os.path.join(d, "manifest.csv"))))
    os.makedirs(os.path.join(d, "clean"), exist_ok=True)
    recs = []
    for r in rows:
        try:
            hl, rec = clean_one(os.path.join(d, r["file"]), t, r)
            hl.writeto(os.path.join(d, "clean", r["file"]), overwrite=True)
            recs.append(rec)
        except Exception as e:  # noqa: BLE001
            print("  skip", r["file"], e)
    os.makedirs(os.path.join(OUT, "clean"), exist_ok=True)
    with open(os.path.join(OUT, "clean", t["id"] + ".csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(recs[0].keys()))
        w.writeheader(); w.writerows(recs)
    good = [r for r in recs if np.isfinite(r["flux_ujy"]) and r["aperture_bad_frac"] < 0.3]
    print(f"{t['id']}: {len(recs)} cleaned, {len(good)} with a good target measurement, "
          f"{sum(r['saturated'] for r in recs)} with the target saturated")
    return recs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only")
    a = ap.parse_args()
    targets = json.load(open(os.path.join(OUT, "targets.json")))
    if a.only:
        keep = a.only.split(",")
        targets = [t for t in targets if t["id"] in keep]
    for t in targets:
        run(t)


if __name__ == "__main__":
    main()
