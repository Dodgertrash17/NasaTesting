# Data files: what the website reads

Everything in this folder is **simulated test data** until the real SPHEREx data arrives.
Regenerate it with `python tools/make_sample_data.py` (add `--boost 5` to exaggerate star motions for demos).

When real data comes, the data pipeline only needs to write files in these shapes. The pages don't need to change.

## Where the site reads data: `js/data-source.js`

The viewer only talks to `SkyData`, never to `fetch()` directly:

- `SkyData.getPatch({ ra, dec, fov, det })` returns the `<id>.json` shape below plus the decoded images,
  or `{ status: "no-coverage", nearest }`, and throws `SkyData.DataError` on network failure (the viewer offers Retry).
- `SkyData.getOverlay("gaia" | "wise", { patch, target })` returns catalogue positions to draw over the image.
- `SkyData.config.source` is `"static"` (these files) or `"api"`. Add `&source=api` to any viewer link to try the live path.

**Live endpoint contract (to build):** `GET api/patch?ra=<deg>&dec=<deg>&fov=<deg>&det=<all|1..6>` returns the same JSON as
`<id>.json` (frame paths relative to the endpoint URL or absolute). Return HTTP 404, or `{ "status": "no-coverage", "nearest": {...} }`,
when SPHEREx has no images there. Cache the five test targets so the demo never depends on IRSA being fast.

## Viewer URL parameters

`viewer.html?ra=&dec=&fov=&name=&det=&mode=&ref=&flags=1&gaia=1&wise=1&track=1&embed=1&source=api`

- `ra`, `dec`: degrees or sexagesimal (`08h55m10.8s`, `-7d14m42s`). `fov`: degrees.
- `det`: `all` or `1`–`6`. `mode`: `each` (one date per frame), `stack` (all dates added), `diff` (subtract).
  `ref` (with `diff`): `first`, `prev` or `stack`.
- `flags`, `gaia`, `wise`, `track`: layers that start switched on. `embed=1`: no site header, for iframes.

## `patches.json`: which data file covers which spot

```json
[{ "id": "wise0855", "title": "WISE 0855", "ra": 133.7951, "dec": -7.2451, "fov_deg": 0.25 }]
```
The viewer opens `data/<id>.json` for the closest entry whose own area (`fov_deg`, default 0.25°) covers the
requested spot, then crops to the field of view the user picked.

## `<id>.json`: one patch of sky over time (Viewer page)

```jsonc
{
  "patch": {
    "id": "wise0855", "name": "WISE 0855",
    "width_px": 146, "height_px": 146,
    "ra": 133.7951, "dec": -7.2451,        // image center, degrees
    "fov_deg": 0.25,
    "pixel_scale_arcsec": 6.15,            // optional; otherwise fov / width
    "simulated": true                      // shows the "Simulated data" badge
  },
  "frames": [{                             // one per date, oldest first, all on the SAME pixel grid, north up
    "file": "frames/wise0855/e00.png",     // relative to this JSON file
    "mjd": 60863.4,                        // Modified Julian Date
    "band": "All 102 bands stacked",       // optional text shown in Raw Data
    "flags": ["3 cosmic rays"],            // optional short notes shown in Raw Data
    "flags_file": "frames/wise0855/e00_flags.png", // optional mask, 255 = flagged pixel
    "flag_bits": { "SATURATED": 12, "COSMIC_RAY": 3 },  // optional: flagged-pixel counts per FLAGS bit
    "detector": "all",                     // "all" (6 detectors added) or 1..6; drives the detector picker
    "wavelength_um": [3.83, 4.41],         // optional, shown in the frame panel
    "n_exposures": 14                      // optional: how many exposures were stacked
  }],
  "light_curve": [{ "mjd": 60863.4, "flux": 812.5, "err": 9.1, "flagged": false }],  // optional: real target photometry;
                                           // otherwise the chart measures the display images (relative only)
  "overlays": {                            // optional catalogue rows; otherwise a sample of the test target only
    "gaia": [{ "ra": 133.79, "dec": -7.24, "label": "Gaia DR3 123", "epoch": 2016.0 }],
    "wise": [{ "ra": 133.79, "dec": -7.24, "label": "CatWISE J0855", "epoch": 2015.4 }]
  },
  "predictions": [{                        // optional: AI / pipeline candidates (right panel)
    "id": "A", "label": "Candidate A",
    "kind": "Moving object (steady drift)",
    "confidence": 0.88,                    // 0..1, or null
    "track": [{ "epoch": 0, "x": 88.1, "y": 72.0 }]   // epoch = index in frames[], x/y = pixel
  }],
  "candidates": []                         // older format; used only if "predictions" is missing
}
```

## `gallery.json`: Gallery and Filtered search cards

`id, name, type (brown-dwarf | star | variable | nebula | asteroid), ra, dec, fov, thumb, status (ready | demo | pending), blurb`

## `dome/`: Sky Dome (not built yet; data ready for testing)

- `bands.json`: 102 bands, each `{index, detector 1-6, channel 0-16, center_um, width_um, resolving_power}`.
  Approximate values for testing; check them against the official SPHEREx band list.
- `poi.json`:
  - `categories`: `{ id: {label, color, shape} }`. These drive the dome's type filter and marker shapes.
    Add a new type (e.g. `comet`) here, and it appears in the filter automatically.
  - `pois`: each `{id, name, category, type, ra, dec, size 1-5, blurb, patch, spectrum[102], epochs[]}`.
    `patch` links to a Viewer data file when there is one.
    `epochs` is one entry per observation date: `{mjd, cube, brightness}` (brightness 1 = normal; used to dim or brighten the dot).
- `cubes/<id>/eNN.png`: one per date. 17 × 6 grid of 32 px images, one per band. Row = detector (short to long wavelength),
  column = channel. Tile *n* is at `x = channel * 32, y = (detector - 1) * 32`. These load only when an object is opened.

The dome is tested with `dome.html?stress=20000&debug` (20,000 extra fake points, with timing shown).
For much bigger catalogs (hundreds of thousands), split `poi.json` into sky tiles and load only the tiles in view.

## Real SPHEREx data vs. this format

Real Level 2 spectral images from IRSA are multi-extension FITS files of 2040 × 2040 pixels
(IMAGE, FLAGS, VARIANCE, ZODI, PSF, WCS-WAVE). Turning them into the files above means:
cutting out around the target, putting every date on the same north-up grid, choosing or
stacking wavelengths, stretching to 8-bit PNG, and turning the FLAGS bitmask into a 0/255 mask.
