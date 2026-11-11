// SkyData: the one place the viewer gets sky data from.
//
// The viewer never calls fetch() itself. It asks SkyData for a patch, an overlay catalogue or a
// light curve, and gets back objects in the shapes described in data/README.md. Today those come
// from the bundled sample files in data/. When the live service exists (a serverless endpoint that
// runs make_patch.py against IRSA, with the five test targets cached), switch `source` to 'api'
// or open any viewer link with &source=api. Nothing else in the site needs to change.
//
// Load after common.js:  <script src="js/data-source.js" defer></script>

const SkyData = (() => {
  const q = new URLSearchParams(location.search);
  const config = {
    source: q.get('source') || 'static',   // 'static' = files in data/, 'api' = live endpoint
    apiBase: 'api/patch',                    // GET api/patch?ra=&dec=&fov=&det= -> same JSON as data/<id>.json
    staticDefaultFovDeg: 0.25,               // patch width when patches.json does not say
  };

  // Catalogues that can be drawn over the image. `epoch` is the year their positions refer to.
  const CATALOGS = {
    gaia: { label: 'Gaia DR3', epoch: 2016.0, shape: 'diamond' },
    wise: { label: 'WISE (AllWISE)', epoch: 2010.5, shape: 'square' },
  };

  class DataError extends Error {}

  async function fetchJSON(url, signal) {
    let res;
    try {
      res = await fetch(url, { signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new DataError('network');
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new DataError(`HTTP ${res.status}`);
    return res.json();
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Could not load ${src}`));
      img.src = src;
    });
  }

  // ---------- find the data file for a position ----------

  let patchIndex = null;
  async function staticIndex(signal) {
    if (!patchIndex) patchIndex = (await fetchJSON('data/patches.json', signal)) || [];
    return patchIndex;
  }

  // -> { status: 'ok', url } | { status: 'no-coverage', nearest }
  async function locateStatic({ ra, dec }, signal) {
    const index = await staticIndex(signal);
    let best = null;
    for (const p of index) {
      if (p.ra == null || p.dec == null) continue;
      const d = separation(ra, dec, p.ra, p.dec);
      if (!best || d < best.d) best = { ...p, d };
    }
    const half = (best?.fov_deg || config.staticDefaultFovDeg) / 2;
    if (best && best.d <= half * 0.95) {
      return { status: 'ok', url: new URL(`data/${best.id}.json`, location.href) };
    }
    return { status: 'no-coverage', nearest: best && { id: best.id, title: best.title, ra: best.ra, dec: best.dec, sepDeg: best.d } };
  }

  function locateApi({ ra, dec, fov, det }) {
    const u = new URL(config.apiBase, location.href);
    u.search = new URLSearchParams({ ra, dec, fov, det: det || 'all' });
    return { status: 'ok', url: u };
  }

  // ---------- public: getPatch ----------

  // Returns one of:
  //   { status: 'ok', patch, jsonUrl, images[], flagMasks[], failed: [frame indexes that would not load] }
  //   { status: 'no-coverage', nearest: { id, title, ra, dec, sepDeg } | null }
  // Throws DataError when the network or server fails (the viewer offers Retry).
  // onProgress(done, total) is called as frames arrive.
  async function getPatch(req, { onProgress, signal } = {}) {
    const where = config.source === 'api' ? locateApi(req) : await locateStatic(req, signal);
    if (where.status !== 'ok') return where;

    const patch = await fetchJSON(where.url, signal);
    if (!patch || patch.status === 'no-coverage' || !patch.frames?.length) {
      return { status: 'no-coverage', nearest: patch?.nearest || null };
    }

    const total = patch.frames.length;
    let done = 0;
    const tick = () => onProgress?.(++done, total);
    const images = await Promise.all(patch.frames.map(f =>
      loadImage(new URL(f.file, where.url)).catch(() => null).finally(tick)));
    const flagMasks = await Promise.all(patch.frames.map(f => f.flags_file
      ? loadImage(new URL(f.flags_file, where.url)).catch(() => null)
      : null));

    // Drop frames whose image failed, but say which ones.
    const failed = images.flatMap((img, i) => (img ? [] : [i]));
    if (failed.length === total) throw new DataError('images');
    if (failed.length) {
      patch.frames = patch.frames.filter((_, i) => images[i]);
    }
    return {
      status: 'ok', patch, jsonUrl: where.url, failed,
      images: images.filter(Boolean),
      flagMasks: flagMasks.filter((_, i) => images[i]),
    };
  }

  // ---------- public: getOverlay ----------

  // Sources from another survey to draw over the image.
  // -> { status: 'ok' | 'sample' | 'none', catalog, sources: [{ ra, dec, label, pm?, epoch }], note }
  // 'ok'     = the data file (or live service) supplied real catalogue rows in patch.overlays[catalog]
  // 'sample' = no rows yet, so we place the test target at its catalogue-epoch position from TARGETS
  // TODO(Pipe/Sky): replace the sample with a real cone search (Gaia DR3 via the ESA or CDS TAP
  // service, CatWISE2020 via IRSA), or hand the field to Aladin Lite v3 with these catalogues.
  function getOverlay(catalog, { patch, target }) {
    const meta = CATALOGS[catalog];
    const rows = patch?.overlays?.[catalog];
    if (rows?.length) return { status: 'ok', catalog: meta, sources: rows, note: `${rows.length} ${meta.label} sources` };
    if (!target) return { status: 'none', catalog: meta, sources: [], note: `${meta.label}: live catalogue search not connected yet.` };
    if (catalog === 'gaia' && target.gaia === false) {
      return { status: 'none', catalog: meta, sources: [], note: `${target.name} is too faint in visible light to be in Gaia.` };
    }
    const pos = propagate(target.ra, target.dec, target.pm, target.epoch, meta.epoch);
    return {
      status: 'sample', catalog: meta,
      sources: [{ ...pos, label: `${target.name} (${meta.label}, ${Math.round(meta.epoch)})`, epoch: meta.epoch, pm: target.pm }],
      note: `Sample: only the test target, placed from its approximate proper motion.`,
    };
  }

  return { config, CATALOGS, DataError, getPatch, getOverlay };
})();
