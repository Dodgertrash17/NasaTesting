# Data files: what the website reads

Everything in this folder is **simulated test data** until the real SPHEREx data arrives.
Regenerate it with `python tools/make_sample_data.py` (add `--boost 5` to exaggerate star motions for demos).

When real data comes, the data pipeline only needs to write files in these shapes. The pages don't need to change.

## `patches.json`: which data file covers which spot

```json
[{ "id": "wise0855", "title": "WISE 0855", "ra": 133.7951, "dec": -7.2451 }]
```
The viewer opens `data/<id>.json` for the closest entry within half the field of view.

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
    "flags_file": "frames/wise0855/e00_flags.png"  // optional mask, 255 = flagged pixel
  }],
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
- `poi.json`: points of interest, each `{id, name, type, ra, dec, size 1-5, blurb, patch, cube, spectrum[102]}`.
  `patch` links to a Viewer data file when there is one.
- `cubes/<id>.png`: 17 × 6 grid of 40 px images, one per band. Row = detector (short to long wavelength),
  column = channel. Tile *n* is at `x = channel * 40, y = (detector - 1) * 40`.

## Real SPHEREx data vs. this format

Real Level 2 spectral images from IRSA are multi-extension FITS files of 2040 × 2040 pixels
(IMAGE, FLAGS, VARIANCE, ZODI, PSF, WCS-WAVE). Turning them into the files above means:
cutting out around the target, putting every date on the same north-up grid, choosing or
stacking wavelengths, stretching to 8-bit PNG, and turning the FLAGS bitmask into a 0/255 mask.
