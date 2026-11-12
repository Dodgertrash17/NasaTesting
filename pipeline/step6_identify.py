"""Pipeline step 6 (IDENTIFY): put names on what step 5 found.

  1. Movers (stars / brown dwarfs moving across visits): look each one up in Gaia DR3 (and CatWISE2020
     for cold ones) at IRSA, searching wide enough to cover the motion since the catalogue epoch. A candidate is CONFIRMED when a catalogue source sits on its track and the
     catalogue proper motion agrees with ours; otherwise it is kept as UNCONFIRMED (often an artefact
     next to a very bright star).
  2. One-frame objects (asteroids, cosmic rays, satellites): ask IMCCE's SkyBoT which known asteroids and
     comets were inside the frame at that exact time, and match them to the peaks (within 12", 2 px).
     Matches become named asteroids with their predicted motion; the rest stay "unidentified".
     Only asteroids with V <= 20.5 are considered (fainter ones are below one frame's depth) and the
     ephemeris error can widen the match circle by at most 30". Answers are cached in cache/<id>/skybot.json.
     Predicted tracks of all V <= 20.5 asteroids are saved too, so the viewer can overlay them.

Writes out/identify/<id>.json
Usage:  python step6_identify.py --only barnard,wise0855 [--workers 4]
"""
import argparse
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from irsa import tap  # noqa: E402

OUT = os.path.join(HERE, "out")
PIX = 6.15
SKYBOT = "https://ssp.imcce.fr/webservices/skybot/api/conesearch.php"
MATCH_ARCSEC = 12.0
MAX_EPHEM_ERR = 30.0     # a poorly known orbit can't stretch the match circle beyond 12" + 30"
VMAG_LIMIT = 20.5        # fainter asteroids are below what one SPHEREx frame can detect
CACHE = os.environ.get("SPHEREX_CACHE", os.path.join(HERE, "cache"))


def f(x, d=float("nan")):
    try:
        return float(x)
    except (TypeError, ValueError):
        return d


def sep_arcsec(ra1, de1, ra2, de2):
    dra = (ra1 - ra2) * math.cos(math.radians((de1 + de2) / 2))
    return math.hypot(dra, de1 - de2) * 3600


# ---------------------------------------------------------------- movers vs catalogues
def pix_to_sky(info, x, y):
    """Grid pixel -> RA/Dec (TAN projection centred on the target, 6.15"/px, east left)."""
    c = (info["size_px"] - 1) / 2
    xi, eta = -(x - c) * PIX / 3600, (y - c) * PIX / 3600       # degrees on the tangent plane
    ra0, de0 = math.radians(info["ra"]), math.radians(info["dec"])
    xi, eta = math.radians(xi), math.radians(eta)
    den = math.cos(de0) - eta * math.sin(de0)
    ra = ra0 + math.atan2(xi, den)
    dec = math.atan2(math.sin(de0) + eta * math.cos(de0), math.hypot(xi, den))
    return math.degrees(ra) % 360, math.degrees(dec)


def identify_mover(m, info, years):
    """Catalogue positions are at their own epoch (Gaia 2016.0, CatWISE ~2015), so a fast star can sit
    far from where SPHEREx sees it now: the search circle must cover the motion since then. Every source
    is propagated to the SPHEREx epoch; among those that land within 9" we prefer one whose proper
    motion agrees with ours (a faint background star can lie closer than the true match)."""
    i = len(m["x"]) // 2
    yr = years[m["visits"][i]]
    ra, dec = pix_to_sky(info, m["x"][i], m["y"][i])
    pm_ours, cosd = m["pm_arcsec_yr"], math.cos(math.radians(dec))

    def agrees(pm):
        return pm > 0.5 and abs(pm - pm_ours) < max(3 * m["pm_err"], 0.3 * pm)

    cands = []
    rad = 30 + 1.5 * pm_ours * abs(yr - 2016.0)
    rows = tap("SELECT source_id, ra, dec, pmra, pmdec, phot_g_mean_mag FROM gaia_dr3_source WHERE "
               f"CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',{ra},{dec},{rad / 3600}))=1")
    for r in rows:
        pmra, pmdec = f(r["pmra"], 0), f(r["pmdec"], 0)          # mas/yr
        dt = yr - 2016.0
        d = sep_arcsec(f(r["ra"]) + pmra * dt / 3.6e6 / cosd, f(r["dec"]) + pmdec * dt / 3.6e6, ra, dec)
        if d < 9:
            cands.append(dict(catalog="Gaia DR3", id=f"Gaia DR3 {r['source_id']}", sep_arcsec=round(d, 1),
                              catalog_pm_arcsec_yr=round(math.hypot(pmra, pmdec) / 1000, 2), gmag=f(r["phot_g_mean_mag"])))
    if not any(agrees(c["catalog_pm_arcsec_yr"]) for c in cands):
        rad = 30 + 1.5 * pm_ours * abs(yr - 2014.5)
        rows = tap("SELECT source_name, ra, dec, pmra, pmdec, w2mpro, meanobsmjd FROM catwise_2020 WHERE "
                   f"CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',{ra},{dec},{rad / 3600}))=1")
        for r in rows:
            pmra, pmdec = f(r["pmra"], 0), f(r["pmdec"], 0)          # arcsec/yr
            dt = yr - (2000 + (f(r["meanobsmjd"]) - 51544.5) / 365.25)
            d = sep_arcsec(f(r["ra"]) + pmra * dt / 3600 / cosd, f(r["dec"]) + pmdec * dt / 3600, ra, dec)
            if d < 9:
                cands.append(dict(catalog="CatWISE2020", id="CWISE " + r["source_name"].strip(), sep_arcsec=round(d, 1),
                                  catalog_pm_arcsec_yr=round(math.hypot(pmra, pmdec), 2), w2mag=f(r["w2mpro"])))
    good = [c for c in cands if agrees(c["catalog_pm_arcsec_yr"])]
    best = min(good or cands, key=lambda c: c["sep_arcsec"], default=None)
    status = "confirmed" if good else "unconfirmed"
    return dict(**m, ra=round(ra, 6), dec=round(dec, 6), epoch=round(yr, 3), match=best, status=status)


# ---------------------------------------------------------------- one-frame objects vs SkyBoT
def skybot(ra, dec, mjd, radius_arcsec, retries=3):
    q = urllib.parse.urlencode({"-ep": f"{mjd + 2400000.5:.6f}", "-ra": f"{ra:.6f}", "-dec": f"{dec:.6f}",
                                "-rs": f"{radius_arcsec:.0f}", "-mime": "text", "-output": "basic",
                                "-loc": "500", "-filter": "0", "-objFilter": "111", "-refsys": "EQJ2000"})
    for a in range(retries):
        try:
            with urllib.request.urlopen(f"{SKYBOT}?{q}", timeout=120) as r:
                if r.status == 204:
                    return []
                text = r.read().decode()
            break
        except Exception:  # noqa: BLE001
            if a == retries - 1:
                return None
            time.sleep(3 * (a + 1))
    out = []
    for line in text.splitlines():
        if line.startswith("#") or "|" not in line:
            continue
        p = [s.strip() for s in line.split("|")]
        h, m_, s = (float(v) for v in p[2].split())
        sign = -1 if p[3].startswith("-") else 1
        dd, dm, ds = (abs(float(v)) for v in p[3].split())
        out.append(dict(number=p[0], name=p[1], ra=15 * (h + m_ / 60 + s / 3600), dec=sign * (dd + dm / 60 + ds / 3600),
                        cls=p[4], vmag=f(p[5]), err_arcsec=f(p[6]), dra_arcsec_h=f(p[8]), ddec_arcsec_h=f(p[9]),
                        dist_au=f(p[10])))
    return out


def identify_frames(t, info, peaks, workers):
    by_frame = defaultdict(list)
    for p in peaks:
        by_frame[(p["file"], p["mjd"])].append(p)
    radius = info["fov_deg"] / 2 * math.sqrt(2) * 3600 + 30
    keys = list(by_frame)
    cpath = os.path.join(CACHE, t["id"], "skybot.json")          # answers cached so reruns are instant
    cache = json.load(open(cpath)) if os.path.exists(cpath) else {}
    todo = [k for k in keys if f"{k[1]:.6f}" not in cache]
    with ThreadPoolExecutor(workers) as ex:
        for k, ans in zip(todo, ex.map(lambda k: skybot(t["ra"], t["dec"], k[1], radius), todo)):
            if ans is not None:
                cache[f"{k[1]:.6f}"] = ans
    os.makedirs(os.path.dirname(cpath), exist_ok=True)
    json.dump(cache, open(cpath, "w"))
    answers = [cache.get(f"{k[1]:.6f}") for k in keys]
    # predicted positions of every catalogued asteroid bright enough to matter, per frame (for viewer overlays)
    in_field = defaultdict(list)
    for (fname, mjd), known in zip(keys, answers):
        for k in known or []:
            if k["vmag"] <= VMAG_LIMIT:
                in_field[(k["number"], k["name"])].append(dict(file=fname, mjd=mjd, ra=round(k["ra"], 6), dec=round(k["dec"], 6)))
    in_field = [dict(name=n, number=num, positions=sorted(v, key=lambda q: q["mjd"])) for (num, n), v in in_field.items()]
    asteroids, unidentified, failed = [], [], 0
    for (fname, mjd), known in zip(keys, answers):
        if known is None:
            failed += 1
            unidentified += by_frame[(fname, mjd)]
            continue
        for p in by_frame[(fname, mjd)]:
            known = [k for k in known if not (k["vmag"] > VMAG_LIMIT)]
            best = min(known, key=lambda k: sep_arcsec(k["ra"], k["dec"], p["ra"], p["dec"]), default=None)
            if best and sep_arcsec(best["ra"], best["dec"], p["ra"], p["dec"]) < MATCH_ARCSEC + min(f(best["err_arcsec"], 0), MAX_EPHEM_ERR):
                asteroids.append(dict(**p, name=best["name"], number=best["number"], cls=best["cls"], vmag=best["vmag"],
                                      sep_arcsec=round(sep_arcsec(best["ra"], best["dec"], p["ra"], p["dec"]), 1),
                                      motion_arcsec_h=[best["dra_arcsec_h"], best["ddec_arcsec_h"]],
                                      dist_au=best["dist_au"]))
            else:
                unidentified.append(p)
    # group detections of the same asteroid
    named = defaultdict(list)
    for a in asteroids:
        named[(a["number"], a["name"])].append(a)
    summary = [dict(name=n, number=num, cls=v[0]["cls"], vmag=v[0]["vmag"], n_detections=len(v),
                    detectors=sorted({a["detector"] for a in v}), first_mjd=min(a["mjd"] for a in v),
                    detections=[{k: a[k] for k in ("file", "mjd", "visit", "detector", "x", "y", "ra", "dec", "snr", "sep_arcsec")}
                                for a in sorted(v, key=lambda a: a["mjd"])])
               for (num, n), v in named.items()]
    return sorted(summary, key=lambda s: -s["n_detections"]), unidentified, failed, len(keys), in_field


def run(t, workers):
    comp = json.load(open(os.path.join(OUT, "compare", t["id"] + ".json")))
    info = json.load(open(os.path.join(OUT, "stack", t["id"] + ".json")))
    years = comp["years"]
    res = dict(id=t["id"], name=t["name"])
    movers = []
    for key in ("movers_all", "movers_cold", "movers_saturated_all"):
        for m in comp.get(key, []):
            m = dict(m, found_in=key.replace("movers_", ""))
            movers.append(identify_mover(m, info, years))
    # one entry per physical mover (the same star can be found in the 'all' and 'cold' images)
    uniq = []
    for m in sorted(movers, key=lambda m: (m["status"] != "confirmed", -m["snr"])):
        if not any(sep_arcsec(m["ra"], m["dec"], u["ra"], u["dec"]) < 15 for u in uniq):
            uniq.append(m)
    res["movers"] = uniq
    ast, unid, failed, nq, in_field = identify_frames(t, info, comp.get("residual_peaks", []), workers)
    res["asteroids"] = ast
    res["asteroids_predicted_in_field"] = in_field      # V <= 20.5, whether or not SPHEREx detected them
    res["unidentified_one_frame"] = len(unid)
    res["unidentified_examples"] = sorted(unid, key=lambda p: -p["snr"])[:20]
    res["skybot_queries"] = nq
    res["skybot_failed"] = failed
    os.makedirs(os.path.join(OUT, "identify"), exist_ok=True)
    json.dump(res, open(os.path.join(OUT, "identify", t["id"] + ".json"), "w"), indent=1)
    conf = [m for m in uniq if m["status"] == "confirmed"]
    print(f"{t['id']}: movers {len(conf)} confirmed / {len(uniq)} "
          f"({', '.join(m['match']['id'] + (' [target]' if m.get('is_target') else '') for m in conf)}); "
          f"asteroids named: {len(ast)} ({sum(a['n_detections'] for a in ast)} detections); "
          f"bright asteroids predicted in field: {len(in_field)}; unidentified one-frame: {len(unid)}; SkyBoT {nq} queries, {failed} failed")
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only")
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    targets = json.load(open(os.path.join(OUT, "targets.json")))
    if a.only:
        keep = a.only.split(",")
        targets = [t for t in targets if t["id"] in keep]
    for t in targets:
        run(t, a.workers)


if __name__ == "__main__":
    main()
