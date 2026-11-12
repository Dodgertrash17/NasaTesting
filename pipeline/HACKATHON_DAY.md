# Running the pipeline fast on hackathon day

Measured on 2026-11-11 with real SPHEREx data (the 5 challenge targets, 1,655 images).

| Way to get the pixels | Time for WISE 0855 (254 images) | Data moved | Notes |
|---|---|---|---|
| IRSA cutout service (`?center=&size=`), 8–12 threads | 3.5–5.5 min per target | 5.4 MB per image (includes a PSF cube we don't use) | IRSA sometimes answers "Server busy, retry later" |
| **NASA's AWS copy, reading only the cutout's bytes** (`--source s3`), 16 threads | **63 s per target** | 0.4 MB per image | Same pixel values as the IRSA cutouts (checked). No login, no AWS account |

Whole-project estimate at the AWS speed (about 4 images per second on one machine):
100 targets × ~290 images ≈ 29,000 images ≈ **2 hours on one machine, ~30 min split across 4 laptops/Colab notebooks**.

## The plan

1. **Do the slow, one-off searches before the event, and commit the results.** The target list
   (`out/targets.json`) needed full-sky Gaia/CatWISE searches that take 2–60 minutes each.
   The image lists (`out/inventory/*.csv`) took ~10 minutes for 100 targets. These are just lists
   of public data, so keep them in the repo. If the rules require building during the event,
   re-running step 1 is one command and runs in the background in ~15 minutes.
2. **Always use `--source s3`.** It reads straight from the public AWS bucket
   `nasa-irsa-spherex` with HTTP range requests, so you only download the ~150 × 150 pixels you need
   and skip the PSF. It is ~4× faster than IRSA cutouts and moves ~13× less data.
3. **Split the targets across people.** `step2_download.py --only id1,id2,...` lets each teammate run a
   quarter of `targets.json` in their own Colab notebook. Colab machines are in Google's cloud, close to AWS,
   so they download faster than home wifi.
4. **Run the 5 challenge targets first** (about 5 minutes total). Then build and demo with those while the
   other 95 download in the background. The site works with any number of targets.
5. **Download less where it doesn't change the picture.**
   - `--cap 20` (the default) keeps at most 20 images per visit per detector. This matters only in the deep
     fields near the ecliptic poles (R Dra has 2,483 images; capped to 358).
   - For the blink "video", a per-detector stack needs only ~6 images per visit (`--cap 6`, ~3× faster).
     Use the full set only where you want complete spectra.
   - Field of view: `--fov 0.1` is fine for most targets. Keep 0.25° for fast movers and Eps Indi (A is 7′ away).
6. **The live "any RA/Dec" endpoint must not fetch ~300 images per request.** The on-demand version should:
   query IRSA once (~10 s), take one detector (or 6 images per visit across all six), and range-read
   ~20–40 cutouts from AWS in parallel (~5–10 s). Then cache the result by sky position so the second visit is instant.
   Vercel Python functions have time and size limits (astropy is large), so check them on Nov 13. A small
   always-on server (Render, Fly.io, Hugging Face Spaces) is a safe fallback, and the 100 precomputed
   targets work with no server at all.
7. **Keep the cache, not the raw files.** Each target's cutouts are ~140 MB. The PNG + JSON that the
   website needs is ~1–2 MB per target. Only the website files go in the repo.

## Commands

```bash
pip install astropy fsspec aiohttp numpy pillow scipy
python step1_select_targets.py --gaia-hpm gaia_hpm.csv --gaia-var gaia_var.csv   # or no flags for live queries
python step1_inventory.py --workers 6
python step2_download.py --only barnard,epsindib,wise0855,rwaur,rdra --source s3 --workers 16
```
