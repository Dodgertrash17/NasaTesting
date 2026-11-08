"""
Make SIMULATED SPHEREx-like test data for every page of the site. Pure Python stdlib, no installs.

    python tools/make_sample_data.py            # realistic motions (stars move ~1 px per 6 months)
    python tools/make_sample_data.py --boost 5  # exaggerate proper motions 5x for demos

Writes into public/data/:
  <target>.json                 one per gallery target: frames over time + AI predictions
  frames/<target>/eNN.png       stacked image per visit (all 102 bands added together)
  frames/<target>/eNN_flags.png pixel mask: 255 = flagged (cosmic ray / saturated)
  dome/bands.json               the 102 SPHEREx bands (approximate centers and widths)
  dome/poi.json                 points of interest for the Sky Dome, each with a 102-band spectrum
  dome/cubes/<poi>/eNN.png      per date: 17 x 6 grid of small images, one per band (row = detector)

Nothing here is real data. Shapes, units and numbers are chosen to behave like the real thing
(pixel size, cadence, proper motions, rough spectral shapes) so the UI can be tested before release.
"""
import json, math, random, struct, sys, zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "public" / "data"
BOOST = float(sys.argv[sys.argv.index("--boost") + 1]) if "--boost" in sys.argv else 1.0
PIX = 6.15                 # arcsec per SPHEREx pixel
SURVEY_START = 60796       # MJD of 2025-05-01
TODAY = 61350              # don't make dates past early Nov 2026

# ---------------------------------------------------------------- small helpers

def png_gray(path, rows):
    """Write an 8-bit grayscale PNG. rows = list of lists of 0..255 ints."""
    h, w = len(rows), len(rows[0])
    raw = b"".join(b"\x00" + bytes(r) for r in rows)
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))

def add_psf(img, x, y, flux, sigma=0.9):
    h, w = len(img), len(img[0])
    r = int(sigma * 4) + 1
    for j in range(max(0, int(y) - r), min(h, int(y) + r + 1)):
        row = img[j]
        for i in range(max(0, int(x) - r), min(w, int(x) + r + 1)):
            row[i] += flux * math.exp(-((i - x) ** 2 + (j - y) ** 2) / (2 * sigma * sigma))

def add_trail(img, x, y, dx, dy, flux, steps=7):
    for s in range(steps):
        t = s / (steps - 1) - 0.5
        add_psf(img, x + dx * t, y + dy * t, flux / steps * 2)

def stretch(img, soft, peak):
    """asinh stretch with fixed limits, so the same target looks comparable across dates."""
    top = math.asinh(peak / soft)
    return [[max(0, min(255, int(255 * math.asinh(max(v, 0) / soft) / top))) for v in r] for r in img]

def mjd_to_year(mjd):
    return 2000.0 + (mjd - 51544.5) / 365.25

def iso(mjd):
    import datetime
    return (datetime.date(1858, 11, 17) + datetime.timedelta(days=int(mjd))).isoformat()

# ---------------------------------------------------------------- spectra (relative F_nu, cartoon shapes)

def bb(lam, T):
    x = 14388.0 / (lam * T)
    return 0.0 if x > 700 else (1 / lam ** 3) / (math.exp(x) - 1)

def g(lam, c, w):
    return math.exp(-0.5 * ((lam - c) / w) ** 2)

def absorb(f, lam, feats):
    for c, w, depth in feats:
        f *= 1 - depth * g(lam, c, w)
    return f

H2O = [(1.40, 0.08, 0.5), (1.90, 0.10, 0.5), (2.70, 0.20, 0.6)]
CH4 = [(1.65, 0.08, 0.6), (2.25, 0.12, 0.6), (3.30, 0.15, 0.9)]
ICES = [(3.05, 0.18, 0.7), (4.27, 0.05, 0.8), (4.67, 0.04, 0.5)]   # H2O, CO2, CO ice

SPECTRA = {
    "y-dwarf":  lambda l: absorb(bb(l, 330) * 1e6 + 0.02 * g(l, 1.27, 0.05), l, H2O + CH4),
    "t-dwarf":  lambda l: absorb(bb(l, 1000) * 50, l, H2O + [(c, w, d * 0.7) for c, w, d in CH4]),
    "m-dwarf":  lambda l: absorb(bb(l, 3100), l, [(c, w, d * 0.3) for c, w, d in H2O] + [(2.3, 0.05, 0.2)]),
    "mira":     lambda l: absorb(bb(l, 2600), l, [(c, w, d * 1.4) for c, w, d in H2O] + [(2.3, 0.06, 0.4), (4.6, 0.12, 0.4)]),
    "t-tauri":  lambda l: bb(l, 4500) + 0.6 * bb(l, 900) * 30 + 0.3 * bb(l, 4500) * g(l, 2.166, 0.02) * 8,
    "hot-star": lambda l: bb(l, 10000),
    "f-star":   lambda l: bb(l, 6000),
    "red-giant":lambda l: absorb(bb(l, 3500), l, [(2.3, 0.06, 0.3), (4.6, 0.1, 0.2)]),
    "nebula":   lambda l: 0.2 * bb(l, 1200) * 40 + 0.03 + 0.5 * g(l, 1.875, 0.02) + 0.25 * g(l, 2.166, 0.02)
                          + 0.6 * g(l, 3.29, 0.03) + 0.3 * g(l, 4.05, 0.03),
    "galaxy":   lambda l: bb(l, 4000) * (1 + 0.25 * g(l, 1.6, 0.3)),
    "starburst":lambda l: bb(l, 4000) * (1 + 0.25 * g(l, 1.6, 0.3)) + bb(4.0, 4000) * (2 * g(l, 3.29, 0.03) + 0.6 * g(l, 4.05, 0.03)),
    "protostar":lambda l: absorb(bb(l, 600) * 200, l, ICES),
    "galactic-center": lambda l: absorb(bb(l, 3500) * 10 ** (-0.4 * 3 * (2.2 / l) ** 2), l, ICES[:2]),
    "synchrotron": lambda l: l ** 0.3 * 0.1 + 0.05 * g(l, 1.64, 0.01),
    "lbv":      lambda l: bb(l, 20000) + bb(l, 800) * 400 + 0.3 * g(l, 2.166, 0.02),
    "white-dwarf": lambda l: bb(l, 15000),
}

def bands():
    edges = [(0.75, 1.09, 39), (1.10, 1.62, 41), (1.63, 2.41, 41), (2.42, 3.82, 35), (3.83, 4.41, 112), (4.42, 5.00, 128)]
    out = []
    for d, (lo, hi, R) in enumerate(edges, start=1):
        for k in range(17):
            c = lo * (hi / lo) ** ((k + 0.5) / 17)
            out.append({"index": len(out), "detector": d, "channel": k, "center_um": round(c, 4),
                        "width_um": round(c / R, 4), "resolving_power": R})
    return out

# ---------------------------------------------------------------- time-series targets

def visits(ra, cadence_days=182.6, offset=None):
    start = SURVEY_START + (offset if offset is not None else (ra / 360.0) * cadence_days)
    out, m = [], start
    while m < TODAY:
        out.append(round(m + random.uniform(-2, 2), 2))
        m += cadence_days
    return out

TARGETS = [
    # pm in arcsec/yr (mu_ra*cos dec, mu_dec). coord_epoch = year the given RA/Dec refer to.
    dict(id="wise0855", name="WISE 0855", ra=133.7951, dec=-7.2451, fov=0.25, spec="y-dwarf",
         flux=40, pm=(-8.05, 0.66), coord_epoch=2014.0, asteroid_in=2, cr_decoy=True),
    dict(id="barnard", name="Barnard's Star", ra=269.4521, dec=4.6934, fov=0.25, spec="m-dwarf",
         flux=3000, pm=(-0.80, 10.33), coord_epoch=2000.0, asteroid_in=1),
    dict(id="epsindib", name="Epsilon Indi B", ra=331.0438, dec=-56.7827, fov=0.25, spec="t-dwarf",
         flux=160, pm=(3.98, -2.47), coord_epoch=2000.0, cr_decoy=True),
    dict(id="rwaur", name="RW Aurigae", ra=76.9563, dec=30.4013, fov=0.25, spec="t-tauri",
         flux=900, pm=(0, 0), coord_epoch=2000.0, var="irregular"),
    dict(id="rdra", name="R Draconis", ra=248.1675, dec=66.7551, fov=0.25, spec="mira",
         flux=1800, pm=(0, 0), coord_epoch=2000.0, var="mira", cadence=30.0),     # near the ecliptic pole: visited often
    dict(id="m42", name="Orion Nebula", ra=83.8221, dec=-5.3911, fov=1.0, spec="nebula",
         flux=0, pm=(0, 0), coord_epoch=2000.0, nebula=True, size=256),
]

def make_target(t):
    rnd = random.Random(t["id"])
    random.seed(t["id"] + "-dates")
    W = t.get("size", 146)
    scale = t["fov"] * 3600 / W
    cx = cy = (W - 1) / 2
    mjds = visits(t["ra"], t.get("cadence", 182.6))
    stars = [(rnd.uniform(2, W - 3), rnd.uniform(2, W - 3), 8 + 900 * rnd.random() ** 7) for _ in range(int(W * W / 260))]
    sat_level = 2500.0
    frames, preds, raw_imgs = [], {}, []

    for e, mjd in enumerate(mjds):
        img = [[0.0] * W for _ in range(W)]
        flags = [[0] * W for _ in range(W)]
        # sky + zodiacal light: a gentle gradient that changes with season
        zodi = 12 + 4 * math.sin(e * 1.7)
        gx, gy = rnd.uniform(-3, 3), rnd.uniform(-3, 3)
        for j in range(W):
            for i in range(W):
                img[j][i] = zodi + gx * (i / W - 0.5) + gy * (j / W - 0.5) + rnd.gauss(0, 2.2)
        if t.get("nebula"):
            for _ in range(14):
                bx, by, bs, bf = rnd.gauss(cx, W / 6), rnd.gauss(cy, W / 6), rnd.uniform(6, 30), rnd.uniform(15, 70)
                r = int(bs * 3)
                for j in range(max(0, int(by) - r), min(W, int(by) + r)):
                    for i in range(max(0, int(bx) - r), min(W, int(bx) + r)):
                        img[j][i] += bf * math.exp(-((i - bx) ** 2 + (j - by) ** 2) / (2 * bs * bs))
            for k in range(4):   # the Trapezium: bright young stars at the center
                add_psf(img, cx + [-3, 2, 4, -1][k], cy + [1, -2, 2, 4][k], 1500, 1.0)
        for x, y, f in stars:
            add_psf(img, x, y, f)

        # the target itself
        years = mjd_to_year(mjd) - t["coord_epoch"]
        tx = cx - t["pm"][0] * years * BOOST / scale        # east is left
        ty = cy - t["pm"][1] * years * BOOST / scale        # north is up
        tf = t["flux"]
        if t.get("var") == "mira":
            tf *= 0.55 + 0.45 * math.cos(2 * math.pi * (mjd - 60900) / 245)
        elif t.get("var") == "irregular":
            tf *= [1.0, 0.45, 0.85, 0.3, 0.9, 0.6][e % 6]
        if tf:
            add_psf(img, tx, ty, tf)
            preds.setdefault("target", []).append({"epoch": e, "x": round(tx, 1), "y": round(ty, 1)})

        # asteroid: shows up as a short trail in one visit only
        if t.get("asteroid_in") == e:
            ax, ay = rnd.uniform(20, W - 20), rnd.uniform(20, W - 20)
            add_trail(img, ax, ay, 5, 2, 220)
            preds["asteroid"] = [{"epoch": e, "x": round(ax, 1), "y": round(ay, 1)}]

        # cosmic rays: sharp single hot pixels (flagged)
        n_cr = rnd.randint(2, 6)
        for k in range(n_cr):
            i, j = rnd.randrange(W), rnd.randrange(W)
            img[j][i] += rnd.uniform(150, 600)
            flags[j][i] = 255
            if t.get("cr_decoy") and e == 1 and k == 0:
                preds["decoy"] = [{"epoch": e, "x": i, "y": j}]

        n_sat = 0
        for j in range(W):
            for i in range(W):
                if img[j][i] > sat_level:
                    img[j][i] = sat_level
                    flags[j][i] = 255
                    n_sat += 1
        raw_imgs.append(img)

        notes = [f"{n_cr} cosmic ray{'s' if n_cr != 1 else ''}"]
        if n_sat: notes.append(f"{n_sat} saturated px")
        if e == len(mjds) - 1 and t["id"] == "barnard": notes.append("near detector edge")
        frames.append({"file": f"frames/{t['id']}/e{e:02d}.png", "flags_file": f"frames/{t['id']}/e{e:02d}_flags.png",
                       "mjd": mjd, "band": "All 102 bands stacked", "detector": "all",
                       "n_exposures": rnd.randint(8, 24), "flags": notes})
        png_gray(ROOT / frames[-1]["flags_file"], flags)

    peak = min(sat_level, max(max(r) for r in raw_imgs[0]))
    for e, img in enumerate(raw_imgs):
        png_gray(ROOT / frames[e]["file"], stretch(img, soft=10, peak=peak))

    # AI predictions (made up, but pointing at the right things)
    p = []
    tr = preds.get("target", [])
    moved = len(tr) > 1 and math.hypot(tr[-1]["x"] - tr[0]["x"], tr[-1]["y"] - tr[0]["y"]) > 0.5
    if tr and moved:
        p.append({"id": "A", "label": "Candidate A", "kind": "Moving object (steady drift)", "confidence": 0.88, "track": tr})
    if t.get("var"):
        p.append({"id": "V", "label": "Candidate A", "kind": "Brightness change", "confidence": 0.93, "track": tr})
    if "asteroid" in preds:
        p.append({"id": "B", "label": "Candidate B", "kind": "Seen on one date only (asteroid?)", "confidence": 0.64, "track": preds["asteroid"]})
    if "decoy" in preds:
        p.append({"id": "C", "label": "Candidate C", "kind": "Possible artifact (cosmic ray)", "confidence": 0.12, "track": preds["decoy"]})

    data = {
        "patch": {"id": t["id"], "name": t["name"], "width_px": W, "height_px": W, "ra": t["ra"], "dec": t["dec"],
                  "fov_deg": t["fov"], "pixel_scale_arcsec": round(scale, 3), "coord_epoch": t["coord_epoch"],
                  "simulated": True, "boost": BOOST},
        "frames": frames,
        "candidates": [{"x": pt["x"], "y": pt["y"], "seen_in": f"e{pt['epoch']}", "match": {"name": q["label"]}}
                       for q in p for pt in q["track"]],
        "predictions": p,
    }
    (ROOT / f"{t['id']}.json").write_text(json.dumps(data, indent=2) + "\n")
    print(f"{t['id']:9s} {len(frames):2d} frames  {iso(mjds[0])} .. {iso(mjds[-1])}")
    return data

# ---------------------------------------------------------------- Sky Dome: points of interest with 102-band cubes

# Categories drive the Sky Dome filter. Each has a label, color and marker shape (shape matters for color-blind users).
CATEGORIES = {
    "star":           {"label": "Stars",                  "color": "#ffd27a", "shape": "circle"},
    "white-dwarf":    {"label": "White dwarfs",           "color": "#cfe3ff", "shape": "diamond"},
    "brown-dwarf":    {"label": "Brown dwarfs",           "color": "#ff8f6b", "shape": "square"},
    "variable":       {"label": "Variable & young stars", "color": "#7be0c8", "shape": "triangle"},
    "exoplanet-host": {"label": "Planet-hosting stars",   "color": "#9be37b", "shape": "ring"},
    "cluster":        {"label": "Star clusters",          "color": "#ffe9a8", "shape": "cross"},
    "nebula":         {"label": "Nebulae & clouds",       "color": "#ff7ac8", "shape": "hexagon"},
    "galaxy":         {"label": "Galaxies",               "color": "#b49cff", "shape": "ellipse"},
    "region":         {"label": "Special regions",        "color": "#8fb3d9", "shape": "dashed"},
}

POIS = [
    # id, name, category, type label, spectrum, ra, dec, dot size 1-5, extended (px sigma), blurb, linked patch
    ("wise0855", "WISE 0855", "brown-dwarf", "Brown dwarf", "y-dwarf", 133.7951, -7.2451, 2, 0, "Coldest known brown dwarf; only shows up at the longest wavelengths.", "wise0855"),
    ("barnard", "Barnard's Star", "star", "Nearby red dwarf", "m-dwarf", 269.4521, 4.6934, 3, 0, "Fastest-moving star on the sky, with small planets found in 2024-25.", "barnard"),
    ("epsindib", "Epsilon Indi B", "brown-dwarf", "Brown dwarf pair", "t-dwarf", 331.0438, -56.7827, 2, 0, "Two brown dwarfs, too close together for SPHEREx to split.", "epsindib"),
    ("luhman16", "Luhman 16", "brown-dwarf", "Brown dwarf pair", "t-dwarf", 162.3289, -53.3194, 2, 0, "The nearest brown dwarfs to the Sun, about 6.5 light-years away.", None),
    ("rwaur", "RW Aurigae", "variable", "Young star", "t-tauri", 76.9563, 30.4013, 3, 0, "Young star with a dusty disk: extra glow at long wavelengths.", "rwaur"),
    ("rdra", "R Draconis", "variable", "Pulsating giant", "mira", 248.1675, 66.7551, 4, 0, "Pulsating red giant with deep water absorption bands.", "rdra"),
    ("mira", "Mira", "variable", "Pulsating giant", "mira", 34.8366, -2.9776, 4, 0, "The original pulsating variable: brightens and fades over 11 months.", None),
    ("etacar", "Eta Carinae", "variable", "Massive star", "lbv", 161.2648, -59.6844, 4, 1, "Huge unstable star wrapped in hot dust.", None),
    ("betelgeuse", "Betelgeuse", "star", "Red supergiant", "red-giant", 88.7929, 7.4071, 5, 0, "One of the brightest infrared stars in the sky.", None),
    ("vega", "Vega", "star", "Hot star", "hot-star", 279.2347, 38.7837, 4, 0, "A hot blue-white star: brightest at short wavelengths.", None),
    ("polaris", "Polaris", "star", "Star", "f-star", 37.9546, 89.2641, 3, 0, "The North Star.", None),
    ("siriusb", "Sirius B", "white-dwarf", "White dwarf", "white-dwarf", 101.2872, -16.7161, 2, 0, "Earth-sized leftover core of a star, orbiting the brightest star in the sky.", None),
    ("procyonb", "Procyon B", "white-dwarf", "White dwarf", "white-dwarf", 114.8255, 5.2250, 2, 0, "A faint white dwarf companion to Procyon.", None),
    ("40erib", "40 Eridani B", "white-dwarf", "White dwarf", "white-dwarf", 63.8180, -7.6528, 2, 0, "The easiest white dwarf to see with a small telescope.", None),
    ("vanmaanen", "Van Maanen's Star", "white-dwarf", "White dwarf", "white-dwarf", 12.2913, 5.3886, 1, 0, "The closest solitary white dwarf, found because of its fast motion.", None),
    ("trappist1", "TRAPPIST-1", "exoplanet-host", "Planet host", "m-dwarf", 346.6224, -5.0414, 2, 0, "A tiny cool star with seven Earth-sized planets.", None),
    ("proxima", "Proxima Centauri", "exoplanet-host", "Planet host", "m-dwarf", 217.4289, -62.6795, 2, 0, "The nearest star to the Sun, with at least one planet.", None),
    ("51peg", "51 Pegasi", "exoplanet-host", "Planet host", "f-star", 344.3667, 20.7689, 2, 0, "The first Sun-like star found with a planet (1995).", None),
    ("pleiades", "Pleiades", "cluster", "Open cluster", "hot-star", 56.75, 24.1167, 4, 2, "Young hot stars in a faint dusty haze.", None),
    ("omegacen", "Omega Centauri", "cluster", "Globular cluster", "red-giant", 201.6970, -47.4795, 4, 3, "Millions of old stars packed into a ball.", None),
    ("m13", "Hercules Cluster (M13)", "cluster", "Globular cluster", "red-giant", 250.4235, 36.4613, 3, 2, "The brightest globular cluster in the northern sky.", None),
    ("m42", "Orion Nebula", "nebula", "Nebula", "nebula", 83.8221, -5.3911, 5, 5, "Glowing gas: emission lines and a 3.3 µm PAH feature.", "m42"),
    ("crab", "Crab Nebula", "nebula", "Supernova remnant", "synchrotron", 83.6331, 22.0145, 3, 3, "Remains of a star that exploded in 1054.", None),
    ("ring", "Ring Nebula (M57)", "nebula", "Planetary nebula", "nebula", 283.3963, 33.0292, 2, 2, "A dying star's shed outer layers, around a new white dwarf.", None),
    ("rhooph", "Rho Ophiuchi cloud", "nebula", "Star-forming cloud", "protostar", 246.79, -24.54, 3, 2, "Baby stars buried in icy dust: water, CO2 and CO ice dips.", None),
    ("taurus", "Taurus molecular cloud", "nebula", "Star-forming cloud", "protostar", 68.0, 26.0, 3, 2, "Nearby stellar nursery, rich in ices.", None),
    ("m31", "Andromeda Galaxy", "galaxy", "Galaxy", "galaxy", 10.6847, 41.2690, 5, 7, "Our nearest big neighbor galaxy.", None),
    ("m82", "Cigar Galaxy (M82)", "galaxy", "Starburst galaxy", "starburst", 148.9685, 69.6797, 4, 4, "Making stars fast: strong 3.3 µm PAH emission.", None),
    ("lmc", "Large Magellanic Cloud", "galaxy", "Galaxy", "galaxy", 80.8939, -69.7561, 5, 8, "Satellite galaxy of the Milky Way.", None),
    ("sgra", "Galactic Center", "region", "Galactic center", "galactic-center", 266.4168, -29.0078, 5, 3, "Hidden by dust in visible light; infrared sees through, with ice absorption.", None),
    ("nep", "North Ecliptic Pole deep field", "region", "Deep field", "galaxy", 270.0, 66.5607, 2, 1, "SPHEREx's most-visited patch: deepest images.", None),
    ("sep", "South Ecliptic Pole deep field", "region", "Deep field", "galaxy", 90.0, -66.5607, 2, 1, "The southern deep field.", None),
]

def ecliptic_lat(ra, dec):
    e = 23.4393 * math.pi / 180
    r, d = ra * math.pi / 180, dec * math.pi / 180
    return math.degrees(math.asin(math.sin(d) * math.cos(e) - math.cos(d) * math.sin(e) * math.sin(r)))

def variability(spec, mjd, k, rnd):
    if spec == "mira":     return 0.55 + 0.45 * math.cos(2 * math.pi * (mjd - 60900) / 245)
    if spec == "t-tauri":  return [1.0, 0.45, 0.85, 0.3, 0.9, 0.6][k % 6]
    if spec == "lbv":      return 1 + 0.12 * math.sin(k * 1.3)
    return 1 + rnd.gauss(0, 0.015)

def make_dome(blist, patches):
    T, COLS, ROWS = 32, 17, 6
    tdict = {t["id"]: t for t in TARGETS}
    pois = []
    for pid, name, cat, typ, spec, ra, dec, size, ext, blurb, patch in POIS:
        rnd = random.Random("dome-" + pid)
        random.seed("dome-dates-" + pid)
        f = SPECTRA[spec]
        flux = [max(f(b["center_um"]), 0.0) for b in blist]
        top = max(flux) or 1.0
        rel = [v / top for v in flux]
        # dates: same as the Viewer data when there is a patch; otherwise twice a year (monthly near the ecliptic poles)
        if patch and patch in patches:
            mjds = [fr["mjd"] for fr in patches[patch]["frames"]]
        else:
            cadence = 30.0 if abs(ecliptic_lat(ra, dec)) > 80 else 182.6
            mjds = visits(ra, cadence)[:6]
        pm = tdict.get(patch, {}).get("pm", (0, 0))
        field = [(rnd.uniform(2, T - 3), rnd.uniform(2, T - 3), rnd.choice([2800, 3500, 4500, 6000, 9000]), 0.05 + 0.4 * rnd.random() ** 4)
                 for _ in range(6)]
        fields_norm = {temp: max(bb(b["center_um"], temp) for b in blist) for temp in {s[2] for s in field}}
        epochs = []
        for k, mjd in enumerate(mjds):
            var = variability(spec, mjd, k, rnd)
            years = (mjd - mjds[0]) / 365.25                 # tile is centered on the object at its first date
            c = (T - 1) / 2
            dx, dy = -pm[0] * years * BOOST / PIX, -pm[1] * years * BOOST / PIX
            sheet = [[0] * (T * COLS) for _ in range(T * ROWS)]
            for b, r in zip(blist, rel):
                lam = b["center_um"]
                img = [[3 + 2.5 * (lam / 5) ** 4 + rnd.gauss(0, 0.45 + 0.3 * lam / 5) for _ in range(T)] for _ in range(T)]
                for x, y, temp, fl in field:
                    add_psf(img, x, y, 60 * fl * bb(lam, temp) / fields_norm[temp])
                if ext:
                    s2 = 2 * ext * ext
                    for j in range(T):
                        for i in range(T):
                            img[j][i] += 50 * r * math.exp(-((i - c) ** 2 / 1.6 + (j - c) ** 2) / s2)
                add_psf(img, c + dx, c + dy, 90 * r * var, 0.9)
                x0, y0 = b["channel"] * T, (b["detector"] - 1) * T
                for j, row in enumerate(stretch(img, soft=6, peak=110)):
                    sheet[y0 + j][x0:x0 + T] = row
            path = f"dome/cubes/{pid}/e{k:02d}.png"
            png_gray(ROOT / path, sheet)
            epochs.append({"mjd": mjd, "cube": path, "brightness": round(var, 3)})
        pois.append({"id": pid, "name": name, "category": cat, "type": typ, "ra": ra, "dec": dec, "size": size,
                     "blurb": blurb, "patch": patch, "spectrum_model": spec,
                     "spectrum": [round(v, 4) for v in rel], "epochs": epochs})
    (ROOT / "dome" / "poi.json").write_text(json.dumps({
        "simulated": True,
        "categories": CATEGORIES,
        "cube_layout": {"tile_px": T, "columns": COLS, "rows": ROWS,
                        "order": "row = detector 1..6 (short to long wavelength), column = channel 0..16 within that detector",
                        "tile_arcsec": round(T * PIX)},
        "spectrum_unit": "relative flux density, max = 1 (cartoon shapes, not real measurements)",
        "pois": pois}, indent=1) + "\n")
    n_ep = sum(len(p["epochs"]) for p in pois)
    print(f"dome     {len(pois)} points of interest, {n_ep} dated 102-band cubes")

# ----------------------------------------------------------------

if __name__ == "__main__":
    import shutil
    blist = bands()
    (ROOT / "dome").mkdir(parents=True, exist_ok=True)
    shutil.rmtree(ROOT / "dome" / "cubes", ignore_errors=True)     # cubes are fully regenerated
    (ROOT / "dome" / "bands.json").write_text(json.dumps({
        "note": "Approximate SPHEREx bands for testing: 6 detectors x 17 channels, 0.75-5.0 µm. Check against the official band list.",
        "bands": blist}, indent=1) + "\n")
    patches = {t["id"]: make_target(t) for t in TARGETS}
    make_dome(blist, patches)
