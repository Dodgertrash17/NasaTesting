"""Pipeline step 1 (QUERY), part A: choose ~100 targets and verify their positions.

Sources (all queried live from IRSA, so the list can be regenerated when new data lands):
  * the five challenge test targets (positions checked against Gaia DR3 / CatWISE2020)
  * fast movers: Gaia DR3 stars with total proper motion > 1.5"/yr
  * brown dwarfs: CatWISE2020 sources with W1-W2 > 1.8 (T/Y-dwarf colours) and pm > 0.6"/yr
  * variables: famous Miras / young stars (positions checked against Gaia DR3),
    plus Gaia DR3 sources flagged VARIABLE with a large G-band scatter

Every target's position is propagated to 2026.0 (middle of the SPHEREx data so far), because
high-proper-motion stars are far from their catalogue coordinates (Barnard's Star moved ~4' since 2000).

Output: out/targets.json
Usage:  python step1_select_targets.py [--gaia-hpm gaia_hpm.csv] [--catwise bd.csv] [--gaia-var var.csv]
        (cached CSVs skip the slow full-sky queries)
"""
import argparse
import json
import math
import os
import re

from irsa import tap, tap_async

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
EPOCH_OUT = 2026.0

# ---- hand-picked targets: name, kind, approx RA/Dec (deg, J2000). Verified below against Gaia/CatWISE.
CHALLENGE = [
    ("barnard",  "Barnard's Star",   "star",        269.4521,  4.6934),
    ("epsindib", "Epsilon Indi B",   "brown-dwarf", 331.0438, -56.7827),
    ("wise0855", "WISE 0855-0714",   "brown-dwarf", 133.79513, -7.24515),
    ("rwaur",    "RW Aurigae",       "variable",     76.9563, 30.4013),
    ("rdra",     "R Draconis",       "variable",    248.1675, 66.7551),
]
FAMOUS_VARIABLES = [  # (id, name, subtype, ra, dec)
    ("mira",   "Mira (o Ceti)",  "Mira variable",          34.8366,  -2.9775),
    ("chicyg", "Chi Cygni",      "Mira variable",         297.6413,  32.9139),
    ("rleo",   "R Leonis",       "Mira variable",         146.8896,  11.4289),
    ("rcas",   "R Cassiopeiae",  "Mira variable",         359.6036,  51.3889),
    ("uori",   "U Orionis",      "Mira variable",          88.9550,  20.1752),
    ("rhya",   "R Hydrae",       "Mira variable",         202.4283, -23.2813),
    ("tcep",   "T Cephei",       "Mira variable",         317.3825,  68.4908),
    ("raql",   "R Aquilae",      "Mira variable",         286.5929,   8.2300),
    ("rtri",   "R Trianguli",    "Mira variable",          39.2584,  34.2642),
    ("ruma",   "R Ursae Majoris","Mira variable",         161.1604,  68.7758),
    ("rboo",   "R Bootis",       "Mira variable",         219.2983,  26.7367),
    ("svir",   "S Virginis",     "Mira variable",         203.2504,  -7.1947),
    ("rcrb",   "R Coronae Borealis", "R CrB variable",    237.1434,  28.1567),
    ("ttau",   "T Tauri",        "young star (T Tauri)",   65.4976,  19.5351),
    ("rytau",  "RY Tauri",       "young star (T Tauri)",   65.4892,  28.4433),
    ("aatau",  "AA Tauri",       "young star (dipper)",    68.7308,  24.4815),
    ("drtau",  "DR Tauri",       "young star (T Tauri)",   71.7759,  16.9786),
    ("fuori",  "FU Orionis",     "young star (FU Ori outburst)", 86.3433, 9.0700),
    ("v1647ori","V1647 Orionis (McNeil's Nebula)", "young star (outburst)", 86.5547, -0.1014),
    ("v1057cyg","V1057 Cygni",   "young star (FU Ori outburst)", 314.7238, 44.2578),
    ("exlup",  "EX Lupi",        "young star (EXor outburst)", 240.7729, -40.3069),
    ("deltacep","Delta Cephei",  "Cepheid",               337.2929,  58.4153),
    ("etaaql", "Eta Aquilae",    "Cepheid",               298.1183,   1.0056),
]
# Famous brown dwarfs (approx J2000; confirmed in CatWISE2020 by colour + proper motion, else skipped).
# Used when the full-sky CatWISE search (slow: scans 1.9 billion rows) is not available.
FAMOUS_BROWN_DWARFS = [
    ("luhman16", "Luhman 16AB", "binary L/T dwarf, nearest brown dwarfs", 162.3290, -53.3194),
    ("w1828", "WISE 1828+2650", "Y dwarf", 277.1300, 26.8437),
    ("w1541", "WISE 1541-2250", "Y dwarf", 235.4642, -22.8408),
    ("w0410", "WISE 0410+1502", "Y dwarf", 62.5963, 15.0446),
    ("w1738", "WISE 1738+2732", "Y dwarf", 264.648, 27.549),
    ("w2056", "WISE 2056+1459", "Y dwarf", 314.12, 14.998),
    ("w1405", "WISE 1405+5534", "Y dwarf", 211.32, 55.57),
    ("w1639", "WISE 1639-6847", "Y dwarf", 249.99, -68.80),
    ("w2220", "WISE 2220-3628", "Y dwarf", 335.10, -36.48),
    ("w0359", "WISE 0359-5401", "Y dwarf", 59.91, -54.03),
    ("w0535", "WISE 0535-7500", "Y dwarf", 83.90, -75.00),
    ("ugps0722", "UGPS 0722-0540", "T9 dwarf", 110.6071, -5.6742),
    ("2m0415", "2MASS 0415-0935", "T8 dwarf", 63.8325, -9.5850),
    ("2m0939", "2MASS 0939-2448", "T8 dwarf (binary?)", 144.90, -24.80),
    ("2m1503", "2MASS 1503+2525", "T5 dwarf", 225.90, 25.43),
    ("sdss1624", "SDSS 1624+0029", "T6 dwarf", 246.13, 0.49),
    ("2m0559", "2MASS 0559-1404", "T4.5 dwarf", 89.83, -14.08),
    ("w0458", "WISE 0458+6434", "T8.5 binary dwarf", 74.72, 64.58),
    ("2m0729", "2MASS 0729-3954", "T8 dwarf", 112.26, -39.90),
    ("w1217", "WISE 1217+1626", "T9 binary dwarf", 184.48, 16.44),
    ("w0607", "WISE 0607+2429", "L9 dwarf", 91.86, 24.49),
    ("denis0255", "DENIS 0255-4700", "L9 dwarf", 43.77, -47.01),
    ("2m0036", "2MASS 0036+1821", "L3.5 dwarf", 9.07, 18.35),
    ("lp944", "LP 944-20", "M9 / young brown dwarf", 54.90, -35.43),
    ("gl570d", "Gliese 570 D", "T7.5 companion to a K star", 224.31, -21.36),
    ("w0647", "WISE 0647-6232", "Y dwarf", 101.84, -62.54),
    ("w0350", "WISE 0350-5658", "Y dwarf", 57.58, -56.97),
]
# Well-known names for the fastest Gaia movers, matched by position (within 20 arcmin of J2000 position).
KNOWN_MOVERS = {
    "Kapteyn's Star": (77.919, -45.018), "Groombridge 1830": (178.245, 37.719),
    "Lacaille 9352": (346.467, -35.853), "CD-37 15492": (1.383, -37.367),
    "61 Cygni": (316.725, 38.749), "Lalande 21185": (165.836, 35.970),
    "Epsilon Indi A": (330.840, -56.786), "Wolf 359": (164.120, 7.015),
    "Proxima Centauri": (217.429, -62.680), "Van Maanen's Star": (12.291, 5.388),
    "Luyten's Star": (111.852, 5.226), "Gliese 1": (1.383, -37.367),
    "Teegarden's Star": (43.254, 16.881), "Ross 128": (176.937, 0.804),
    "Omicron2 Eridani (40 Eri)": (63.818, -7.653), "Lacaille 8760 (AX Mic)": (319.313, -38.867),
    "Gliese 83.1": (30.0, 13.05), "Struve 2398": (280.69, 59.63), "Groombridge 34": (4.595, 44.023),
    "Ross 154": (282.456, -23.836), "Ross 248": (355.48, 44.17), "Wolf 1061": (247.575, -12.666),
    "LHS 292": (162.05, -11.33), "Gliese 687": (264.11, 68.34), "Gliese 674": (262.17, -46.89),
    "Gliese 440 (white dwarf)": (176.46, -64.84), "Kruger 60": (337.0, 57.7),
    "Barnard's Star": (269.452, 4.693), "Mu Cassiopeiae": (17.07, 54.92),
    "Gliese 299": (122.0, 8.77), "LHS 1723": (75.49, -6.95),
}


def ang(ra1, de1, ra2, de2):
    r = math.radians
    c = (math.sin(r(de1)) * math.sin(r(de2)) +
         math.cos(r(de1)) * math.cos(r(de2)) * math.cos(r(ra1 - ra2)))
    return math.degrees(math.acos(max(-1, min(1, c))))


def propagate(ra, dec, pmra_mas, pmdec_mas, epoch0, epoch1=EPOCH_OUT):
    """Linear proper-motion propagation (good to <0.1" over a few decades for these stars)."""
    dt = epoch1 - epoch0
    dec1 = dec + pmdec_mas * dt / 3.6e6
    ra1 = ra + pmra_mas * dt / 3.6e6 / math.cos(math.radians(dec))
    return ra1 % 360, dec1


def gaia_cone(ra, dec, radius_deg, extra=""):
    q = ("SELECT source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag, bp_rp, phot_variable_flag "
         f"FROM gaia_dr3_source WHERE CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',{ra},{dec},{radius_deg}))=1 {extra}")
    return tap(q)


def catwise_cone(ra, dec, radius_deg):
    q = ("SELECT source_name, ra, dec, pmra, pmdec, w1mpro, w2mpro, meanobsmjd FROM catwise_2020 "
         f"WHERE CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',{ra},{dec},{radius_deg}))=1")
    return tap(q)


def f(x, default=0.0):
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


def verify_with_gaia(ra, dec, radius_deg, pick="brightest"):
    rows = [r for r in gaia_cone(ra, dec, radius_deg) if r["phot_g_mean_mag"]]
    if not rows:
        return None
    if pick == "fastest":
        rows.sort(key=lambda r: -math.hypot(f(r["pmra"]), f(r["pmdec"])))
    else:
        rows.sort(key=lambda r: f(r["phot_g_mean_mag"], 99))
    return rows[0]


def gaia_target(tid, name, kind, g, subtype="", source="Gaia DR3"):
    ra1, de1 = propagate(f(g["ra"]), f(g["dec"]), f(g["pmra"]), f(g["pmdec"]), 2016.0)
    pm = math.hypot(f(g["pmra"]), f(g["pmdec"]))
    return dict(id=tid, name=name, kind=kind, subtype=subtype, ra=round(ra1, 6), dec=round(de1, 6),
                epoch=EPOCH_OUT, ra_cat=f(g["ra"]), dec_cat=f(g["dec"]), epoch_cat=2016.0,
                pmra_mas=round(f(g["pmra"]), 2), pmdec_mas=round(f(g["pmdec"]), 2), pm_mas=round(pm, 1),
                parallax_mas=round(f(g["parallax"]), 3), gmag=round(f(g["phot_g_mean_mag"]), 2),
                catalog_id=f"Gaia DR3 {g['source_id']}", position_source=source)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gaia-hpm"); ap.add_argument("--catwise"); ap.add_argument("--gaia-var")
    ap.add_argument("--bd-mode", choices=["curated", "catwise-scan"], default="curated")
    ap.add_argument("--n-movers", type=int, default=40)
    ap.add_argument("--n-bd", type=int, default=25)
    ap.add_argument("--n-gaia-var", type=int, default=12)
    a = ap.parse_args()
    import csv
    load = lambda p: list(csv.DictReader(open(p)))
    targets, log = [], []

    # 1. challenge targets ------------------------------------------------------------------
    for tid, name, kind, ra, dec in CHALLENGE:
        if tid == "wise0855":   # too faint for Gaia: use CatWISE2020 (positions at MJD ~57170, 2015.4)
            rows = catwise_cone(ra, dec, 60 / 3600)
            rows.sort(key=lambda r: -(f(r["w1mpro"], 99) - f(r["w2mpro"], 99)))  # reddest W1-W2 first
            c = rows[0]
            pmra, pmdec = f(c["pmra"]) * 1000, f(c["pmdec"]) * 1000
            ep = 2000.0 + (f(c["meanobsmjd"]) - 51544.5) / 365.25
            ra1, de1 = propagate(f(c["ra"]), f(c["dec"]), pmra, pmdec, ep)
            targets.append(dict(id=tid, name=name, kind=kind, subtype="Y dwarf (coldest known brown dwarf)",
                                ra=round(ra1, 6), dec=round(de1, 6), epoch=EPOCH_OUT, ra_cat=f(c["ra"]),
                                dec_cat=f(c["dec"]), epoch_cat=round(ep, 2), pmra_mas=round(pmra, 1),
                                pmdec_mas=round(pmdec, 1), pm_mas=round(math.hypot(pmra, pmdec), 1),
                                w1=f(c["w1mpro"]), w2=f(c["w2mpro"]), catalog_id="CatWISE " + c["source_name"],
                                position_source="CatWISE2020", challenge=True))
            continue
        pick = "brightest" if kind == "variable" else "fastest"
        rad = 60 / 3600 if kind == "variable" else 8 / 60   # movers: search 8' (Barnard moved ~4.5')
        g = verify_with_gaia(ra, dec, rad, pick)
        sub = {"barnard": "red dwarf, fastest-moving star in the sky",
               "epsindib": "binary brown dwarf (T1+T6) orbiting Eps Indi A",
               "rwaur": "young star (irregular dimming)", "rdra": "Mira variable (~245 d period)"}[tid]
        if tid == "epsindib":  # B is faint in Gaia; take the red, fast source near A
            rows = [r for r in gaia_cone(ra, dec, 3 / 60) if f(r["bp_rp"], 0) > 2.5 or not r["bp_rp"]]
            rows = [r for r in rows if math.hypot(f(r["pmra"]), f(r["pmdec"])) > 3000] or rows
            g = rows[0] if rows else g
        t = gaia_target(tid, name, kind, g, sub)
        t["challenge"] = True
        targets.append(t)

    taken = lambda ra, dec, r=3 / 60: any(ang(ra, dec, t["ra"], t["dec"]) < r for t in targets)

    # 2. fast movers (Gaia DR3 pm > 1.5"/yr) -------------------------------------------------
    hpm = load(a.gaia_hpm) if a.gaia_hpm else tap(
        "SELECT source_id, ra, dec, pmra, pmdec, pm, parallax, phot_g_mean_mag, bp_rp FROM gaia_dr3_source WHERE pm > 1500")
    hpm = [r for r in hpm if r["phot_g_mean_mag"] and 5.0 <= f(r["phot_g_mean_mag"]) <= 17.5]
    hpm.sort(key=lambda r: -f(r["pm"]))
    n = 0
    for g in hpm:
        if n >= a.n_movers:
            break
        t = gaia_target("", "", "star", g, "high proper motion star")
        if taken(t["ra"], t["dec"]):      # binary companion or already a challenge target
            continue
        nm = next((k for k, (r0, d0) in KNOWN_MOVERS.items() if ang(r0, d0, t["ra_cat"], t["dec_cat"]) < 20 / 60), None)
        t["name"] = nm or f"Gaia DR3 {g['source_id']}"
        t["id"] = re.sub(r"[^a-z0-9]", "", (nm or "gaia" + g["source_id"][-8:]).lower())[:16]
        if t["parallax_mas"] > 0 and t["pm_mas"] / 1000 > 0:
            vt = 4.74 * (t["pm_mas"] / 1000) / (t["parallax_mas"] / 1000)
            if vt > 150:
                t["subtype"] = "halo star (fast, from the Milky Way's old population)"
        if t["parallax_mas"] > 100:
            t["subtype"] = "nearby star (within 10 parsecs)"
        targets.append(t)
        n += 1
    log.append(f"movers: {n}")

    # 3. brown dwarfs (CatWISE2020) ----------------------------------------------------------
    n = 0
    if a.bd_mode == "curated":
        for tid, name, sub, ra, dec in FAMOUS_BROWN_DWARFS:
            rows = catwise_cone(ra, dec, 2.5 / 60)
            # Known brown dwarfs are among the brightest W2 sources in their field and move > 0.2"/yr.
            # Pick the brightest W2 source that moves and is red; reject faint noise (W2 > 16.5).
            ok = []
            for c in rows:
                pm = math.hypot(f(c["pmra"]), f(c["pmdec"]))
                w2 = f(c["w2mpro"], 99)
                col = f(c["w1mpro"], 99) - w2 if c["w1mpro"] else 3.0
                need_col = 1.5 if sub[0] in "YT" else 0.3      # cold T/Y dwarfs are very red in W1-W2
                close = ang(ra, dec, f(c["ra"]), f(c["dec"])) < 1.5 / 60
                if pm > 0.2 and col > need_col and w2 < 16.5 and close:
                    ok.append((w2, c))
            if not ok:
                log.append(f"  could not confirm {name} in CatWISE; skipped")
                continue
            c = min(ok, key=lambda x: x[0])[1]
            pmra, pmdec = f(c["pmra"]) * 1000, f(c["pmdec"]) * 1000
            ep = 2000.0 + (f(c["meanobsmjd"]) - 51544.5) / 365.25
            ra1, de1 = propagate(f(c["ra"]), f(c["dec"]), pmra, pmdec, ep)
            if taken(ra1, de1, 1 / 60):
                continue
            targets.append(dict(id=tid, name=name, kind="brown-dwarf", subtype=sub, ra=round(ra1, 6),
                                dec=round(de1, 6), epoch=EPOCH_OUT, ra_cat=f(c["ra"]), dec_cat=f(c["dec"]),
                                epoch_cat=round(ep, 2), pmra_mas=round(pmra, 1), pmdec_mas=round(pmdec, 1),
                                pm_mas=round(math.hypot(pmra, pmdec), 1), w1=f(c["w1mpro"]), w2=f(c["w2mpro"]),
                                catalog_id="CatWISE " + c["source_name"].strip(), position_source="CatWISE2020"))
            n += 1
    bd = [] if a.bd_mode == "curated" else (load(a.catwise) if a.catwise else tap_async(
        "SELECT source_name, ra, dec, pmra, pmdec, sigpmra, w1mpro, w2mpro, w2snr, meanobsmjd FROM catwise_2020 "
        "WHERE w1mpro - w2mpro > 1.8 AND pmra*pmra+pmdec*pmdec > 0.36 AND w2snr > 30"))
    for r in bd:
        r["_pm"] = math.hypot(f(r["pmra"]), f(r["pmdec"]))
        r["_col"] = f(r["w1mpro"]) - f(r["w2mpro"])
    # prefer reliable (pm >> error) and red; mix the coldest and the fastest
    bd = [r for r in bd if r["_pm"] > 5 * max(f(r["sigpmra"]), 0.01) and r["_pm"] < 10]
    bd.sort(key=lambda r: -(r["_pm"] + 0.5 * r["_col"]))
    for c in bd:
        if n >= a.n_bd:
            break
        pmra, pmdec = f(c["pmra"]) * 1000, f(c["pmdec"]) * 1000
        ep = 2000.0 + (f(c["meanobsmjd"]) - 51544.5) / 365.25
        ra1, de1 = propagate(f(c["ra"]), f(c["dec"]), pmra, pmdec, ep)
        if taken(ra1, de1):
            continue
        col = c["_col"]
        sub = "Y/late-T dwarf (very cold)" if col > 3 else ("T dwarf (methane brown dwarf)" if col > 2.2 else "T dwarf")
        targets.append(dict(id="cw" + re.sub(r"[^0-9]", "", c["source_name"])[:12], name="CWISE " + c["source_name"].strip(),
                            kind="brown-dwarf", subtype=sub, ra=round(ra1, 6), dec=round(de1, 6), epoch=EPOCH_OUT,
                            ra_cat=f(c["ra"]), dec_cat=f(c["dec"]), epoch_cat=round(ep, 2),
                            pmra_mas=round(pmra, 1), pmdec_mas=round(pmdec, 1), pm_mas=round(math.hypot(pmra, pmdec), 1),
                            w1=f(c["w1mpro"]), w2=f(c["w2mpro"]), catalog_id="CatWISE " + c["source_name"].strip(),
                            position_source="CatWISE2020"))
        n += 1
    log.append(f"brown dwarfs: {n}")

    # 4. variables ---------------------------------------------------------------------------
    nv = 0
    for tid, name, sub, ra, dec in FAMOUS_VARIABLES:
        g = verify_with_gaia(ra, dec, 45 / 3600)
        if not g or ang(ra, dec, f(g["ra"]), f(g["dec"])) * 3600 > 30:
            log.append(f"  could not confirm {name} in Gaia; skipped")
            continue
        t = gaia_target(tid, name, "variable", g, sub)
        targets.append(t)
        nv += 1
    gv = load(a.gaia_var) if a.gaia_var else []
    gv.sort(key=lambda r: -f(r["amp"]))
    for g in gv:
        if nv >= len(FAMOUS_VARIABLES) + a.n_gaia_var:
            break
        t = gaia_target("gv" + g["source_id"][-10:], f"Gaia DR3 {g['source_id']}", "variable", g,
                        "large-amplitude red variable (Gaia-flagged)")
        if taken(t["ra"], t["dec"], 10 / 60):
            continue
        t["gaia_amp"] = round(f(g["amp"]), 3)
        targets.append(t)
        nv += 1
    log.append(f"variables: {nv}")

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "targets.json"), "w") as fh:
        json.dump(targets, fh, indent=1)
    print("\n".join(log))
    print(f"wrote {len(targets)} targets to out/targets.json")


if __name__ == "__main__":
    main()
