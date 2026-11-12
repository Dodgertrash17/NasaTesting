# SPHEREx pipeline

Turns real SPHEREx Level 2 images (NASA/IPAC IRSA) into the files the website in `public/` reads.
Every step reads the previous step's output, so you can rerun any step on its own.

| Step | Script | What it does | Output |
|---|---|---|---|
| 1 Query | `step1_select_targets.py`, `step1_inventory.py` | Picks 100 targets (fast movers, brown dwarfs, variables) and lists every SPHEREx image of each | `out/targets.json`, `out/inventory/` |
| 2 Download | `step2_download.py` | Reads only the cutout bytes from NASA's AWS copy | `cache/<id>/*.fits` |
| 3 Clean | `step3_clean.py` | Zodiacal light, FLAGS masks, sky level, target photometry, wavelength per frame | `cache/<id>/clean/`, `out/clean/<id>.csv` |
| 4 Align + stack | `step4_align_stack.py` | Same north-up 6.15″ grid for every frame; one stack per detector per visit | `cache/<id>/stack.fits`, `out/stack/<id>.json` |
| 5 Compare | `step5_compare.py` | Movers, brightness changes (same-wavelength test), one-frame objects | `out/compare/<id>.json` |
| 6 Identify | `step6_identify.py` | Movers checked against Gaia DR3 / CatWISE2020; one-frame objects against known asteroids (SkyBoT) | `out/identify/<id>.json` |
| 7 Export | `step7_export.py` | PNG frames, `<id>.json`, patches/gallery lists, Sky Dome cubes and spectra | `out/web/data/` (copy over `public/data/`) |
| 8 Web | `server.py` | Serves the site plus the live `api/patch` endpoint | http://localhost:8000 |

## Run everything

```bash
pip install numpy scipy astropy fsspec aiohttp requests pillow
export SPHEREX_CACHE=/somewhere/with/15GB          # optional; default pipeline/cache
python pipeline/run_all.py --parallel 3 --site public/data   # steps 2-6 per target, then step 7 for all
```
`run_all.py` skips targets that are already done, so it can be stopped and restarted.
About 2 minutes of downloading and 2 to 3 minutes of asteroid lookups per target.

## Live endpoint

```bash
python pipeline/server.py --port 8000
# http://localhost:8000/viewer.html?ra=10.6847&dec=41.269&fov=0.1&source=api
```
`GET /api/patch?ra=&dec=&fov=&det=` answers at once for any processed target (from `public/data/`).
For any other spot it lists the SPHEREx images there, downloads up to `--max` (default 60) cutouts,
cleans and stacks them, and writes `public/data/live/<key>.json` plus PNGs (usually 30 to 90 s the first
time, instant after that). No SPHEREx images there gives HTTP 404 `{"status": "no-coverage", "nearest": …}`.
Live patches skip the movers/asteroid steps (too slow for a click); the processed targets have them.
