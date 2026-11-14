# SPHEREx pipeline

Turns real SPHEREx Level 2 images (NASA/IPAC IRSA) into the files the website in `public/` reads.
Every step reads the previous step's output, so you can rerun any step on its own.

**How we get the data.** The SPHEREx access follows the
[IRSA SPHEREx tutorial notebooks](https://caltech-ipac.github.io/irsa-tutorials/) (NASA/IPAC IRSA):
find images with an ADQL query on IRSA's TAP service (`spherex.obscore`, see `irsa.py`), then read only the
cutout's bytes from NASA's public AWS copy (`s3://nasa-irsa-spherex`, step 2), as the cloud-access tutorial does.
Catalogue lookups use **Gaia DR3** (`gaia_dr3_source`) and CatWISE2020, both through IRSA TAP.

**Credits.** Data and acknowledgements for every source (SPHEREx, IRSA, CatWISE2020, Gaia DR3 with the
ESA/Gaia/DPAC acknowledgement, SkyBoT, WiseView) are on the site's About page (`public/about.html#credits`).
Keep that list in step with any new data source.

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
python pipeline/server.py --port 8000            # options: --max 36 images, --live-max-mb 500
# http://localhost:8000/search.html  -> Raw search works for any RA/Dec
```
`GET /api/patch?ra=&dec=&fov=&det=&layers=gaia,wise` answers at once for any processed target (from `public/data/`)
or any spot processed live before. For a new spot it starts a background job and answers HTTP 202 with its
progress (`step`, `steps`, `message`, `done`, `total`, `elapsed_s`); the viewer asks again every 1.5 s and shows
"Step 2 of 4 · Downloading and cleaning SPHEREx images (14 of 36)". The job lists the SPHEREx images there,
downloads up to `--max` cutouts, cleans and stacks them, fetches the ticked catalogues (Gaia DR3, CatWISE2020)
at the same time, and writes `public/data/live/<key>.json` plus PNGs (usually 20 to 50 s, instant after that).
No SPHEREx images there gives HTTP 404 `{"status": "no-coverage", "nearest": …}`.
Live patches skip the movers/asteroid steps (too slow for a click); the processed targets have them.

**Storage.** `public/data/live` is a cache on the machine running `server.py`, not part of the website build
(it is in `.gitignore`). Raw and cleaned frames are deleted as soon as a patch is saved, a patch is about
0.2 to 0.5 MB, and the folder is kept under `--live-max-mb` (default 500 MB) by deleting the least recently
viewed patches first. A static-only deploy (for example Vercel without the Python server) serves just the
100 processed targets; the raw search then says the spot needs the live server.

**Hosting.** `render.yaml` (repo root) runs the live server on Render's free plan so the Vercel site can search
any RA/Dec. Setup clicks and free-plan behaviour (cold starts, temporary cache): [RENDER.md](RENDER.md).
