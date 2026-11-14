// SkyData: the one place the viewer gets sky data from.
//
// The viewer never calls fetch() itself. It asks SkyData for a patch, an overlay catalogue or a
// light curve, and gets back objects in the shapes described in data/README.md.
//
// Where patches come from (`source`, or &source= in the URL; the live server address is LIVE_SERVER below):
//   'auto'   (default) the pre-processed files in data/ first; for any other spot, the live endpoint
//            (pipeline/server.py, GET api/patch) that downloads and stacks SPHEREx images on demand.
//            Where no live server is running (a static-only deploy) it falls back to "no coverage".
//   'static' only data/.   'api' always the live endpoint.
// Which catalogues to load comes from &layers= (default gaia,wise; empty = SPHEREx images only).
//
// Load after common.js:  <script src="js/data-source.js" defer></script>

// The live SPHEREx server (pipeline/server.py). Run locally, the site and the server share one address,
// so the relative 'api/patch' is used. Anywhere else (the Vercel site) it calls the hosted copy on Render.
// If Render gave your service a different address, change LIVE_SERVER (or test one with &api=https://…).
const LIVE_SERVER = 'https://skyblink-spherex-live.onrender.com';

const SkyData = (() => {
  const q = new URLSearchParams(location.search);
  const LAYER_KEYS = { gaia: 1, wise: 1 };
  const isLocal = ['localhost', '127.0.0.1', ''].includes(location.hostname) || location.hostname.endsWith('.onrender.com');
  const config = {
    source: q.get('source') || 'auto',     // 'auto' = data/ then live endpoint, 'static', 'api'
    apiBase: q.get('api') ? `${q.get('api').replace(/\/$/, '')}/api/patch`
      : isLocal ? 'api/patch' : `${LIVE_SERVER}/api/patch`,   // GET ?ra=&dec=&fov=&det=&layers= -> data/<id>.json shape
    wakeAfterMs: 2500,                       // no answer this long: the free server is probably waking up
    staticDefaultFovDeg: 0.25,               // patch width when patches.json does not say
    pollMs: 1500,                            // how often to ask the live endpoint while it works
    layers: (q.has('layers') ? q.get('layers') : 'gaia,wise').split(',').filter(k => k in LAYER_KEYS),
  };
  let usedApi = false;                       // true once a patch actually came from the live endpoint

  // Catalogues that can be drawn over the image. `epoch` is the year their positions refer to.
  const CATALOGS = {
    gaia: { label: 'Gaia DR3', epoch: 2016.0, shape: 'diamond' },
    wise: { label: 'WISE (CatWISE2020)', epoch: 2015.4, shape: 'square' },
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
      // frames from the live server on another host: ask for CORS so the viewer can read their pixels
      if (new URL(src, location.href).origin !== location.origin) img.crossOrigin = 'anonymous';
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

  function apiUrl({ ra, dec, fov, det }) {
    const u = new URL(config.apiBase, location.href);
    u.search = new URLSearchParams({ ra, dec, fov, det: det || 'all', layers: config.layers.join(',') || 'none' });  // 'none': an empty value can be dropped on the way
    return u;
  }

  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); });
  });

  // Ask the live endpoint until the patch is ready. While it works it answers 202 with
  // { stage, step, steps, done, total, message, elapsed_s }, passed to onStage for the progress display.
  // -> { status: 'ok', patch } | { status: 'no-coverage', nearest } | { status: 'unavailable' }
  async function fetchLive(url, { onStage, signal, optional }) {
    for (let first = true; ; first = false) {
      let res;
      // Free hosting puts the server to sleep when nobody uses it; the first request then takes up to a
      // minute while it starts. Say so instead of looking stuck.
      const wake = first && setTimeout(() => onStage?.({ wake: true, message: 'Waking up the live SPHEREx server' }),
        config.wakeAfterMs);
      try {
        res = await fetch(url, { signal, cache: 'no-store' });
      } catch (err) {
        clearTimeout(wake);
        if (err.name === 'AbortError') throw err;
        if (optional) return { status: 'unavailable' };
        throw new DataError('network');
      }
      clearTimeout(wake);
      const isJson = (res.headers.get('content-type') || '').includes('json');
      if (!isJson) {                         // no live server here (static hosting answers with a page)
        if (optional) return { status: 'unavailable' };
        throw new DataError(`HTTP ${res.status}`);
      }
      const body = await res.json();
      if (res.status === 200) return { status: 'ok', patch: body };
      if (res.status === 202) { onStage?.(body); await sleep(config.pollMs, signal); continue; }
      if (res.status === 404) return { status: 'no-coverage', nearest: body.nearest || null };
      throw new DataError(body.error || `HTTP ${res.status}`);
    }
  }

  // ---------- public: getPatch ----------

  // Returns one of:
  //   { status: 'ok', patch, jsonUrl, images[], flagMasks[], failed: [frame indexes that would not load] }
  //   { status: 'no-coverage', nearest: { id, title, ra, dec, sepDeg } | null }
  // Throws DataError when the network or server fails (the viewer offers Retry).
  // onStage(info) reports the live endpoint's progress; onProgress(done, total) is called as frames arrive.
  async function getPatch(req, { onProgress, onStage, signal } = {}) {
    let patch, base;
    const fromStatic = config.source === 'api' ? null : await locateStatic(req, signal);
    if (fromStatic?.status === 'ok') {
      patch = await fetchJSON(fromStatic.url, signal);
      base = fromStatic.url;
    } else if (config.source === 'static') {
      return fromStatic;
    } else {
      const url = apiUrl(req);
      const live = await fetchLive(url, { onStage, signal, optional: config.source === 'auto' });
      if (live.status === 'unavailable') return { ...fromStatic, liveUnavailable: true };
      if (live.status !== 'ok') return { ...live, nearest: live.nearest || fromStatic?.nearest || null };
      patch = live.patch;
      base = url;
      usedApi = true;
    }
    if (!patch || patch.status === 'no-coverage' || !patch.frames?.length) {
      return { status: 'no-coverage', nearest: patch?.nearest || null };
    }
    const where = { url: base };

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
    if (!config.layers.includes(catalog)) {
      return { status: 'none', catalog: meta, sources: [], note: `${meta.label} was not loaded for this search. Search again with it ticked to see it.` };
    }
    const rows = patch?.overlays?.[catalog];
    if (rows?.length) {
      const what = rows.length === 1 ? 'source' : rows.length >= 300 ? 'brightest sources' : 'sources';
      return { status: 'ok', catalog: meta, sources: rows, note: `${rows.length} ${meta.label} ${what}.` };
    }
    if (patch?.overlays && catalog in patch.overlays && !target) {
      return { status: 'none', catalog: meta, sources: [], note: `${meta.label}: no sources in this field.` };
    }
    if (!target) return { status: 'none', catalog: meta, sources: [], note: `${meta.label}: catalogue positions are only available from the live search.` };
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

  return { config, CATALOGS, DataError, getPatch, getOverlay, get usedApi() { return usedApi; } };
})();
