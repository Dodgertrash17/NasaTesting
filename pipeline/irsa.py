"""Small helpers for talking to NASA/IPAC IRSA (the SPHEREx archive).

Only uses `requests`-free stdlib + astropy so it runs anywhere (Colab, laptop, Vercel build).
"""
import csv
import io
import time
import urllib.parse
import urllib.request

TAP_SYNC = "https://irsa.ipac.caltech.edu/TAP/sync"
TAP_ASYNC = "https://irsa.ipac.caltech.edu/TAP/async"
IBE_DATA = "https://irsa.ipac.caltech.edu/ibe/data/"


def _post(url, fields, timeout=600):
    data = urllib.parse.urlencode(fields).encode()
    with urllib.request.urlopen(urllib.request.Request(url, data=data), timeout=timeout) as r:
        return r.read().decode(), r.geturl()


def tap(query, timeout=600, retries=3):
    """Run an ADQL query on IRSA TAP (sync) and return a list of dict rows."""
    last = None
    for attempt in range(retries):
        try:
            text, _ = _post(TAP_SYNC, {"QUERY": query, "FORMAT": "csv"}, timeout)
            if text.lstrip().startswith("<?xml"):
                raise RuntimeError("TAP error: " + text[:400])
            return list(csv.DictReader(io.StringIO(text)))
        except Exception as e:  # network blips: retry with backoff
            last = e
            time.sleep(2 ** attempt * 3)
    raise last


def tap_async(query, poll=20, max_wait=3600):
    """Run a long query (full-table scans) as an async job."""
    req = urllib.request.Request(TAP_ASYNC, data=urllib.parse.urlencode(
        {"QUERY": query, "FORMAT": "csv", "PHASE": "RUN"}).encode())
    with urllib.request.urlopen(req, timeout=120) as r:
        job = r.geturl()
    t0 = time.time()
    while time.time() - t0 < max_wait:
        with urllib.request.urlopen(job + "/phase", timeout=60) as r:
            phase = r.read().decode().strip()
        if phase == "COMPLETED":
            with urllib.request.urlopen(job + "/results/result", timeout=600) as r:
                return list(csv.DictReader(io.StringIO(r.read().decode())))
        if phase in ("ERROR", "ABORTED"):
            raise RuntimeError(f"async job {job} {phase}")
        time.sleep(poll)
    raise TimeoutError(job)


def spherex_images_at(ra, dec):
    """Every SPHEREx Level-2 spectral image (all releases) whose footprint contains (ra, dec)."""
    q = ("SELECT obs_id, obs_collection, t_min, t_max, energy_bandpassname, em_min, em_max, access_url "
         "FROM spherex.obscore "
         f"WHERE CONTAINS(POINT('ICRS',{ra:.6f},{dec:.6f}), s_region)=1")
    rows = tap(q)
    for r in rows:
        r["detector"] = int(r["energy_bandpassname"].replace("SPHEREx-D", ""))
        r["t_min"] = float(r["t_min"])
        r["em_min_um"] = float(r["em_min"]) * 1e6
        r["em_max_um"] = float(r["em_max"]) * 1e6
    return sorted(rows, key=lambda r: r["t_min"])


def survey_of(mjd):
    """SPHEREx maps the sky every ~6 months starting 2025-05-01 (MJD 60796). 1-based survey number."""
    return int((mjd - 60796.0) // 182.6) + 1
