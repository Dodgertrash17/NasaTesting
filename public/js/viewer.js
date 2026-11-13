// Viewer page. Everything it shows is described by its URL, so links can be shared and embedded:
//   viewer.html?ra=133.795&dec=-7.245&fov=0.1667[&name=WISE+0855][&det=all][&mode=each|stack|diff]
//              [&ref=first|prev|stack][&flags=1][&gaia=1][&wise=1][&track=1][&embed=1][&source=api]
// Data comes only through SkyData (data-source.js). Shared helpers live in common.js.
//
// Layout: go-to bar (coordinates, field of view, presets) · left: frame info + flags ·
// center: image, player, add/subtract · brightness chart · timeline · right: layers + AI candidates.

const SPEED_MS = { slow: 1000, normal: 500, fast: 334 };   // swaps per second: 1, 2, 3
const MIN_SWAP_MS = 334;     // hard floor: never more than 3 swaps (1.5 flashes) a second (WCAG 2.3.1)
const DISPLAY_PX = 768;      // draw at least this big so markers stay crisp
const APERTURE_R = 2.5;      // brightness measurement radius, in image pixels
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;

// SPHEREx's six detector arrays (approximate wavelength ranges, µm). Check against the official band list.
const DETECTORS = [
  { id: 'all', label: 'All detectors added' },
  { id: '1', label: 'Detector 1 · 0.75–1.09 µm' },
  { id: '2', label: 'Detector 2 · 1.10–1.62 µm' },
  { id: '3', label: 'Detector 3 · 1.63–2.41 µm' },
  { id: '4', label: 'Detector 4 · 2.42–3.82 µm' },
  { id: '5', label: 'Detector 5 · 3.83–4.41 µm' },
  { id: '6', label: 'Detector 6 · 4.42–5.00 µm' },
];

const MODE_HELP = {
  each: 'Each date as observed. Press Play, or use the arrows, and look for a dot that jumps or changes brightness.',
  stack: 'All dates added together. Faint steady sources get clearer; anything that moved smears into a short trail.',
  diff: 'One date minus another. Grey means no change, bright means it appeared or got brighter, dark means it left or faded.',
};

const state = {
  req: null,          // { ra, dec, fov, name, det, mode, ref } from the URL
  target: null,       // preset from TARGETS when the coordinates match one
  data: null,         // SkyData.getPatch() result
  view: [],           // indexes into data.patch.frames for the chosen detector, oldest first
  frame: 0,           // position in view[]
  playing: false,
  timer: null,
  speed: REDUCED_MOTION ? 'slow' : 'normal',
  revealed: false,
  selected: null,     // id of the highlighted AI prediction
  aperture: null,     // { x, y } image pixel the user clicked, or null to follow the target
  geom: null,         // pixel <-> sky mapping and the field-of-view crop
};

let pixelCache = [];  // ImageData per frame, made on first use
let maskCache = [];   // flag mask ImageData per frame
let flagLayers = [];  // red overlay canvas per frame
let sourceCache = new Map();
let lightCurve = [];  // [{ vi, mjd, rel, flagged, nFlag }]

const $ = (s) => document.querySelector(s);
const els = Object.fromEntries([
  'back-link', 'goto-form', 'g-ra', 'g-dec', 'g-fov', 'goto-error', 'preset-list',
  'viewer-title', 'target-coords', 'target-note', 'copy-link', 'copy-embed', 'open-full',
  'empty', 'empty-title', 'empty-detail', 'empty-actions', 'viewer', 'stage', 'sky', 'sky-caption',
  'sim-badge', 'fov-badge', 'frame-badge', 'count-badge', 'loading', 'loading-text', 'loading-bar', 'loading-detail',
  'prev', 'blink', 'next', 'speed', 'ref-wrap', 'ref', 'det', 'mode-help',
  'lc-svg', 'lc-tip', 'lc-where', 'lc-reset', 'lc-summary', 'lc-rows',
  'frame', 'frame-date', 'tl-ticks', 'dome-link',
  'raw-frame', 'flag-summary', 'raw-cursor', 'raw-patch', 'download',
  'show-flags', 'ov-gaia', 'ov-wise', 'show-track', 'overlay-note',
  'stretch', 'contrast', 'invert', 'crosshair', 'ai-list', 'reveal', 'status',
].map(id => [id.replace(/-(\w)/g, (_, c) => c.toUpperCase()), document.getElementById(id)]));
const canvas = els.sky;

function setStatus(text) { els.status.textContent = text; }

function fillDL(dl, rows) {
  dl.replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    return [dt, dd];
  }));
}

const patch = () => state.data?.patch;
const fullIndex = (vi = state.frame) => state.view[vi];
const frameAt = (vi = state.frame) => patch().frames[fullIndex(vi)];

// ---------- geometry: sky <-> image pixels, and the field-of-view crop ----------

// Image pixel (x, y) uses pixel-index coordinates: pixel i is centered on i. North up, east left.
function makeGeom() {
  const p = patch().patch || {};
  const img = state.data.images[0];
  const W = p.width_px || img.naturalWidth, H = p.height_px || img.naturalHeight;
  const scale = p.pixel_scale_arcsec || ((p.fov_deg || 0.25) * 3600) / W;   // arcsec per pixel
  const ra0 = p.ra ?? state.req.ra, dec0 = p.dec ?? state.req.dec;
  const cosd = Math.cos(dec0 * Math.PI / 180);
  const g = {
    W, H, scale,
    skyToPx(ra, dec) {
      const dra = ((ra - ra0 + 540) % 360) - 180;
      return { x: (W - 1) / 2 - (dra * cosd * 3600) / scale, y: (H - 1) / 2 - ((dec - dec0) * 3600) / scale };
    },
    pxToSky(x, y) {
      return { ra: (ra0 - ((x - (W - 1) / 2) * scale) / 3600 / cosd + 360) % 360, dec: dec0 - ((y - (H - 1) / 2) * scale) / 3600 };
    },
  };
  // Crop: a square of the requested field of view, centered on the requested coordinates.
  const want = Math.round((state.req.fov * 3600) / scale);
  g.size = Math.max(8, Math.min(want, Math.max(W, H)));
  g.limited = want > Math.max(W, H);
  const c = g.skyToPx(state.req.ra, state.req.dec);
  g.sx = Math.round(c.x + 0.5 - g.size / 2);
  g.sy = Math.round(c.y + 0.5 - g.size / 2);
  g.k = Math.max(1, Math.ceil(DISPLAY_PX / g.size));     // whole-number zoom keeps pixels square
  g.toCanvas = (v, axis) => (v + 0.5 - (axis === 'x' ? g.sx : g.sy)) * g.k;
  return g;
}

// Where the test target should be on a date, from its proper motion (null for other coordinates).
function expectedPx(mjd) {
  const t = state.target;
  if (!t) return null;
  const pos = propagate(t.ra, t.dec, t.pm, patch().patch?.coord_epoch ?? t.epoch, mjdToYear(mjd));
  // The sample generator puts the target at the patch center at coord_epoch; real data uses the catalogue epoch.
  return state.geom.skyToPx(pos.ra, pos.dec);
}

// The spot we measure brightness at on frame vi.
function aperturePx(vi) {
  if (state.aperture) return state.aperture;
  const e = expectedPx(frameAt(vi).mjd);
  if (e) return e;
  return state.geom.skyToPx(state.req.ra, state.req.dec);
}

// ---------- pixels and frame sources ----------

function imageData(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height);
}
function getPixels(i) { return (pixelCache[i] ||= imageData(state.data.images[i])); }
function getMask(i) {
  const m = state.data.flagMasks[i];
  if (!m) return null;
  return (maskCache[i] ||= imageData(m));
}

function toCanvas(imgData) {
  const c = document.createElement('canvas');
  c.width = imgData.width; c.height = imgData.height;
  c.getContext('2d').putImageData(imgData, 0, 0);
  return c;
}

// Average of every date for the current detector.
function stackData() {
  if (sourceCache.has('stack')) return sourceCache.get('stack');
  const frames = state.view.map(getPixels);
  const { width, height } = frames[0];
  const out = new ImageData(width, height);
  for (let p = 0; p < out.data.length; p += 4) {
    let s = 0;
    for (const f of frames) s += f.data[p];
    const v = s / frames.length;
    out.data[p] = out.data[p + 1] = out.data[p + 2] = v;
    out.data[p + 3] = 255;
  }
  sourceCache.set('stack', out);
  return out;
}

function refInfo(vi) {
  const ref = state.req.ref;
  if (ref === 'stack') return { data: stackData(), label: 'all dates' };
  const rvi = ref === 'prev' ? (vi - 1 + state.view.length) % state.view.length : 0;
  return { data: getPixels(fullIndex(rvi)), label: mjdToDate(frameAt(rvi).mjd) };
}

function frameSource(vi) {
  const mode = state.req.mode;
  if (mode === 'each') return state.data.images[fullIndex(vi)];
  const key = mode === 'stack' ? 'stack-canvas' : `diff|${state.req.ref}|${vi}`;
  if (sourceCache.has(key)) return sourceCache.get(key);
  let out;
  if (mode === 'stack') {
    out = toCanvas(stackData());
  } else {
    const a = getPixels(fullIndex(vi)), b = refInfo(vi).data;
    const d = new ImageData(a.width, a.height);
    for (let p = 0; p < a.data.length; p += 4) {
      const v = 128 + 1.5 * (a.data[p] - b.data[p]);
      d.data[p] = d.data[p + 1] = d.data[p + 2] = v;
      d.data[p + 3] = 255;
    }
    out = toCanvas(d);
  }
  sourceCache.set(key, out);
  return out;
}

// Turn a 0/255 mask image into a see-through red layer.
function makeFlagLayer(i) {
  const m = getMask(i);
  if (!m) return null;
  const d = new ImageData(m.width, m.height);
  for (let p = 0; p < m.data.length; p += 4) {
    const on = m.data[p] > 0;
    d.data[p] = 255; d.data[p + 1] = 60; d.data[p + 2] = 60; d.data[p + 3] = on ? 210 : 0;
  }
  return toCanvas(d);
}

// ---------- drawing ----------

function drawShape(ctx, shape, x, y, r, { color, dashed = false, fill = false, lw = 2 }) {
  ctx.save();
  ctx.lineWidth = lw;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  if (dashed) ctx.setLineDash([r / 2, r / 3]);
  ctx.beginPath();
  if (shape === 'circle') ctx.arc(x, y, r, 0, Math.PI * 2);
  if (shape === 'square') ctx.rect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6);
  if (shape === 'diamond') { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); }
  fill ? ctx.fill() : ctx.stroke();
  ctx.restore();
}

function label(ctx, text, x, y) {
  ctx.save();
  ctx.font = `600 ${Math.max(12, canvas.width / 48)}px "Atkinson Hyperlegible Next", system-ui, sans-serif`;
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#000c';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = '#e8ecf6';
  ctx.fillText(text, x, y);
  ctx.restore();
}

function render() {
  if (!state.data || !state.view.length) return;
  const g = state.geom, fi = fullIndex(), frame = frameAt();
  canvas.width = g.size * g.k;
  canvas.height = g.size * g.k;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(frameSource(state.frame), -g.sx * g.k, -g.sy * g.k, g.W * g.k, g.H * g.k);
  drawOverlays(ctx, fi, frame);

  const n = state.view.length;
  const date = mjdToDate(frame.mjd);
  els.frame.max = Math.max(0, n - 1);
  els.frame.value = state.frame;
  els.frame.disabled = n < 2 || state.req.mode === 'stack';
  els.frameDate.textContent = state.req.mode === 'stack'
    ? `${n} dates added: ${mjdToDate(frameAt(0).mjd)} → ${mjdToDate(frameAt(n - 1).mjd)}`
    : `${date} · image ${state.frame + 1} of ${n}`;
  els.frameBadge.textContent = state.req.mode === 'stack' ? `Sum of ${n} dates`
    : state.req.mode === 'diff' ? `${date} − ${refInfo(state.frame).label}` : date;
  els.countBadge.textContent = state.req.mode === 'stack' ? '' : `${state.frame + 1} / ${n}`;
  els.countBadge.hidden = state.req.mode === 'stack';
  els.blink.setAttribute('aria-pressed', String(state.playing));
  els.blink.textContent = state.playing ? '❚❚ Pause' : '▶ Play';
  const canPlay = n > 1 && state.req.mode !== 'stack';
  for (const b of [els.blink, els.prev, els.next]) b.disabled = !canPlay;
  for (const [i, b] of [...els.tlTicks.children].entries()) b.setAttribute('aria-current', String(i === state.frame));
  els.skyCaption.textContent = caption(frame);
  renderRawFrame(frame, fi);
  renderFlags(frame, fi);
  highlightChart();
}

function caption(frame) {
  const what = state.req.mode === 'stack' ? 'All dates added together'
    : state.req.mode === 'diff' ? 'Difference image' : `Image from ${mjdToDate(frame.mjd)}`;
  const det = DETECTORS.find(d => d.id === state.req.det)?.label || '';
  return `${what} · ${det} · ${formatFov(state.geom.size * state.geom.scale / 3600)} field, north up, east left.`;
}

function drawOverlays(ctx, fi, frame) {
  const g = state.geom, k = g.k;
  const X = (v) => g.toCanvas(v, 'x'), Y = (v) => g.toCanvas(v, 'y');
  const R = Math.max(8, canvas.width * 0.03);

  if (els.showFlags.checked) {
    flagLayers[fi] ??= makeFlagLayer(fi);
    if (flagLayers[fi]) ctx.drawImage(flagLayers[fi], -g.sx * k, -g.sy * k, g.W * k, g.H * k);
  }

  // Where the test target should be today, from its proper motion.
  const now = expectedPx(frame.mjd);
  if (els.showTrack.checked && now) {
    drawShape(ctx, 'circle', X(now.x), Y(now.y), R * 1.3, { color: '#ffc857', dashed: true });
  }

  // Gaia / WISE positions, with a line to where the source is now.
  for (const [key, box] of [['gaia', els.ovGaia], ['wise', els.ovWise]]) {
    if (!box.checked) continue;
    const ov = SkyData.getOverlay(key, { patch: patch(), target: state.target });
    const color = key === 'gaia' ? '#c9a7ff' : '#7be0c8';
    const few = ov.sources.length <= 12;          // a whole field of sources: markers only, no labels
    for (const s of ov.sources) {
      const p = g.skyToPx(s.ra, s.dec);
      if (now && state.target && few) {
        ctx.save();
        ctx.strokeStyle = color; ctx.globalAlpha = 0.7; ctx.lineWidth = 2; ctx.setLineDash([6, 5]);
        ctx.beginPath(); ctx.moveTo(X(p.x), Y(p.y)); ctx.lineTo(X(now.x), Y(now.y)); ctx.stroke();
        ctx.restore();
      }
      drawShape(ctx, ov.catalog.shape, X(p.x), Y(p.y), few ? R * 0.7 : R * 0.45, { color, lw: few ? 2.5 : 1.5 });
      if (few) label(ctx, `${key === 'gaia' ? 'Gaia' : 'WISE'} ${Math.round(s.epoch ?? ov.catalog.epoch)}`, X(p.x) + R, Y(p.y) - R * 0.6);
    }
  }

  // AI candidates. track[].epoch indexes data.patch.frames.
  if (state.revealed) {
    for (const p of predictions()) {
      const pt = p.track.find(t => t.epoch === fi);
      if (pt) drawShape(ctx, 'circle', X(pt.x), Y(pt.y), R, { color: '#ffc857aa', dashed: true });
    }
  }
  const sel = predictions().find(p => p.id === state.selected);
  if (sel) {
    if (sel.track.length > 1) {
      ctx.save();
      ctx.strokeStyle = '#ffc857'; ctx.globalAlpha = 0.6; ctx.lineWidth = Math.max(1.5, k / 3);
      ctx.setLineDash([k * 1.5, k]);
      ctx.beginPath();
      sel.track.forEach((t, i) => ctx[i ? 'lineTo' : 'moveTo'](X(t.x), Y(t.y)));
      ctx.stroke();
      ctx.restore();
    }
    const pt = sel.track.find(t => t.epoch === fi);
    if (pt) drawShape(ctx, 'circle', X(pt.x), Y(pt.y), R, { color: '#ffc857' });
  }

  // The spot being measured for the brightness chart, when the user picked it.
  if (state.aperture) {
    drawShape(ctx, 'circle', X(state.aperture.x), Y(state.aperture.y), APERTURE_R * k, { color: '#ffffff', lw: 2 });
  }
}

function applyFilters() {
  const b = els.stretch.value, c = els.contrast.value, inv = els.invert.checked ? 1 : 0;
  canvas.style.filter = `brightness(${b}) contrast(${c}) invert(${inv})`;
  els.stage.classList.toggle('no-crosshair', !els.crosshair.checked);
}

// ---------- left panel: frame info and flags ----------

function renderRawFrame(frame, fi) {
  const det = frame.detector == null ? '—' : frame.detector === 'all' ? 'all 6 added' : `D${frame.detector}`;
  fillDL(els.rawFrame, [
    ['Date', mjdToDate(frame.mjd)],
    ['MJD', frame.mjd.toFixed(3)],
    ['Detector', det],
    ['Wavelength', frame.wavelength_um ? `${frame.wavelength_um[0]}–${frame.wavelength_um[1]} µm` : frame.band || '—'],
    ['Exposures', frame.n_exposures ?? '—'],
    ['File', frame.file.split('/').pop()],
  ]);
  els.download.href = new URL(frame.file, state.data.jsonUrl);
}

function countFlagged(fi, x0, y0, x1, y1) {
  const m = getMask(fi);
  if (!m) return null;
  let n = 0;
  for (let y = Math.max(0, y0); y < Math.min(m.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(m.width, x1); x++) if (m.data[(y * m.width + x) * 4] > 0) n++;
  }
  return n;
}

function renderFlags(frame, fi) {
  const g = state.geom;
  const box = els.flagSummary;
  box.replaceChildren();
  const notes = frame.flags || [];
  const bits = frame.flag_bits ? Object.entries(frame.flag_bits) : [];   // optional { "SATURATED": 12, ... }
  const inView = countFlagged(fi, g.sx, g.sy, g.sx + g.size, g.sy + g.size);

  const chips = document.createElement('div');
  chips.className = 'flag-chips';
  for (const t of bits.length ? bits.map(([k, v]) => `${k.toLowerCase().replace(/_/g, ' ')}: ${v} px`) : notes) {
    const s = document.createElement('span');
    s.className = 'pill' + (/satur|edge/i.test(t) ? ' pill-warn' : '');
    s.textContent = t;
    chips.append(s);
  }
  if (!chips.children.length) chips.innerHTML = '<span class="pill pill-ok">No flags on this date</span>';
  box.append(chips);

  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = inView == null ? 'No flag mask for this date.'
    : `${inView} flagged pixel${inView === 1 ? '' : 's'} in view.` + (els.showFlags.checked ? ' Shown in red.' : ' Turn on "Contamination flags" in Layers to see them.');
  box.append(p);

  const lc = lightCurve.find(l => l.vi === state.frame);
  if (lc?.flagged) {
    const w = document.createElement('p');
    w.className = 'flag-warn';
    w.textContent = `⚠ The measured spot has ${lc.nFlag} flagged pixel${lc.nFlag === 1 ? '' : 's'} on this date (saturation or a cosmic ray), so its brightness here is not reliable.`;
    box.append(w);
  }
}

function renderRawPatch() {
  const p = patch().patch || {};
  const g = state.geom;
  const frames = state.view.map(i => patch().frames[i]);
  fillDL(els.rawPatch, [
    ['RA (deg)', state.req.ra.toFixed(5)],
    ['Dec (deg)', state.req.dec.toFixed(5)],
    ['Field shown', formatFov((g.size * g.scale) / 3600)],
    ['Data covers', formatFov((Math.max(g.W, g.H) * g.scale) / 3600)],
    ['Pixel', `${g.scale.toFixed(2)}″`],
    ['Dates', frames.length],
    ['Span', `${mjdToDate(frames[0].mjd)} → ${mjdToDate(frames.at(-1).mjd)}`],
    ['Source', SkyData.usedApi ? 'processed live from SPHEREx' : p.simulated ? 'sample files (simulated)' : 'pre-processed SPHEREx files'],
  ]);
}

function canvasToPx(e) {
  const g = state.geom;
  const r = canvas.getBoundingClientRect();
  return {
    x: g.sx + ((e.clientX - r.left) / r.width) * g.size - 0.5,
    y: g.sy + ((e.clientY - r.top) / r.height) * g.size - 0.5,
  };
}

function renderCursor(e) {
  if (!state.data) return;
  const g = state.geom;
  const { x: fx, y: fy } = canvasToPx(e);
  const x = Math.round(fx), y = Math.round(fy);
  if (x < 0 || y < 0 || x >= g.W || y >= g.H) { fillDL(els.rawCursor, [['', 'outside the data']]); return; }
  const idx = (y * g.W + x) * 4;
  const v = getPixels(fullIndex()).data[idx];
  const v0 = getPixels(fullIndex(0)).data[idx];
  const sky = g.pxToSky(x, y);
  const flagged = getMask(fullIndex())?.data[idx] > 0;
  fillDL(els.rawCursor, [
    ['Pixel', `${x}, ${y}`],
    ['RA', formatRA(sky.ra)],
    ['Dec', formatDec(sky.dec)],
    ['Value', v],
    ['Δ vs first', (v - v0 > 0 ? '+' : '') + (v - v0)],
    ['Flagged', flagged ? 'yes' : 'no'],
  ]);
}

// ---------- brightness over time ----------

// Sum inside a small circle minus the local background (median of a ring around it).
// Sample data are 8-bit display images, so this is relative brightness only. When the pipeline
// supplies patch.light_curve (real fluxes), the chart uses that instead for the target.
function measure(fi, x, y) {
  const d = getPixels(fi), m = getMask(fi);
  const W = d.width, H = d.height;
  const ring = [];
  let sum = 0, n = 0, nFlag = 0;
  for (let j = Math.floor(y - 8); j <= Math.ceil(y + 8); j++) {
    for (let i = Math.floor(x - 8); i <= Math.ceil(x + 8); i++) {
      if (i < 0 || j < 0 || i >= W || j >= H) continue;
      const r = Math.hypot(i - x, j - y);
      const v = d.data[(j * W + i) * 4];
      if (r <= APERTURE_R) {
        sum += v; n++;
        if (m?.data[(j * W + i) * 4] > 0) nFlag++;
      } else if (r >= 5 && r <= 8) ring.push(v);
    }
  }
  ring.sort((a, b) => a - b);
  const bg = ring.length ? ring[ring.length >> 1] : 0;
  return { flux: sum - bg * n, nFlag, offImage: n === 0 };
}

function computeLightCurve() {
  const supplied = !state.aperture && patch().light_curve;
  let raw;
  if (supplied) {
    raw = state.view.map((fi, vi) => {
      const f = patch().frames[fi];
      const row = supplied.find(r => Math.abs(r.mjd - f.mjd) < 0.01) || {};
      return { vi, mjd: f.mjd, flux: row.flux ?? null, nFlag: row.flagged ? 1 : 0 };
    });
  } else {
    raw = state.view.map((fi, vi) => {
      const p = aperturePx(vi);
      return { vi, mjd: patch().frames[fi].mjd, ...measure(fi, p.x, p.y) };
    });
  }
  const good = raw.filter(r => r.flux != null && !r.offImage).map(r => r.flux).sort((a, b) => a - b);
  const median = good.length ? good[good.length >> 1] : 0;
  const weak = median < 20;     // nothing much there: show raw counts, not ratios
  lightCurve = raw.filter(r => r.flux != null && !r.offImage).map(r => ({
    vi: r.vi, mjd: r.mjd, nFlag: r.nFlag, flagged: r.nFlag > 0,
    rel: weak ? r.flux : r.flux / median,
  }));
  lightCurve.weak = weak;
  lightCurve.supplied = !!supplied;
  renderChart();
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs, text) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

const chart = { x: null, y: null };

function renderChart() {
  const svg = els.lcSvg;
  svg.replaceChildren();
  const pts = lightCurve;
  const where = state.aperture ? 'at the spot you clicked'
    : state.target ? `at ${state.target.name}${state.target.kind === 'mover' ? ' (following its motion)' : ''}`
    : 'at the center of the field';
  els.lcWhere.textContent = where;
  els.lcReset.hidden = !state.aperture;
  els.lcRows.replaceChildren(...pts.map(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="mono">${mjdToDate(p.mjd)}</td><td class="mono">${p.rel.toFixed(2)}</td><td>${p.flagged ? `${p.nFlag} flagged px` : '—'}</td>`;
    return tr;
  }));

  if (pts.length < 2) {
    els.lcSummary.textContent = 'Need at least two dates to show a change in brightness.';
    return;
  }
  const W = 640, H = 220, L = 70, Rm = 20, T = 16, B = 30;
  const t0 = pts[0].mjd, t1 = pts.at(-1).mjd;
  let lo = Math.min(...pts.map(p => p.rel)), hi = Math.max(...pts.map(p => p.rel));
  if (!lightCurve.weak) { lo = Math.min(lo, 1); hi = Math.max(hi, 1); }
  const pad = (hi - lo) * 0.12 || 0.1;
  lo -= pad; hi += pad;
  chart.x = (m) => L + 14 + ((m - t0) / Math.max(1e-9, t1 - t0)) * (W - L - Rm - 14);
  chart.y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

  // grid + axes (recessive)
  for (const v of [lo + pad, (lo + hi) / 2, hi - pad]) {
    svg.append(svgEl('line', { x1: L, x2: W - Rm, y1: chart.y(v), y2: chart.y(v), class: 'lc-grid' }));
    svg.append(svgEl('text', { x: L - 8, y: chart.y(v) + 4, 'text-anchor': 'end', class: 'lc-axis' }, v.toFixed(lightCurve.weak ? 0 : 2)));
  }
  if (!lightCurve.weak) {
    svg.append(svgEl('line', { x1: L, x2: W - Rm, y1: chart.y(1), y2: chart.y(1), class: 'lc-base' }));
    svg.append(svgEl('text', { x: L - 8, y: chart.y(1) + 18, 'text-anchor': 'end', class: 'lc-axis' }, 'typical'));
  }
  const mid = pts[Math.floor(pts.length / 2)];
  for (const [p, anchor] of [[pts[0], 'start'], [mid, 'middle'], [pts.at(-1), 'end']]) {
    svg.append(svgEl('text', { x: chart.x(p.mjd), y: H - 8, 'text-anchor': anchor, class: 'lc-axis' }, mjdToShort(p.mjd)));
  }

  // line + points
  svg.append(svgEl('polyline', { points: pts.map(p => `${chart.x(p.mjd)},${chart.y(p.rel)}`).join(' '), class: 'lc-line' }));
  for (const p of pts) {
    const cx = chart.x(p.mjd), cy = chart.y(p.rel);
    const g = svgEl('g', { class: 'lc-pt' + (p.flagged ? ' flagged' : ''), 'data-vi': p.vi });
    g.append(svgEl('circle', { cx, cy, r: 14, class: 'lc-hit' }));
    if (p.flagged) g.append(svgEl('path', { d: `M${cx} ${cy - 7} L${cx + 7} ${cy + 5} L${cx - 7} ${cy + 5} Z`, class: 'lc-mark' }));
    else g.append(svgEl('circle', { cx, cy, r: 5, class: 'lc-mark' }));
    svg.append(g);
  }
  svg.append(svgEl('circle', { id: 'lc-current', r: 10, class: 'lc-current' }));

  // summary sentence (also the chart's accessible description)
  const vals = pts.map(p => p.rel);
  const max = Math.max(...vals), min = Math.min(...vals);
  const nFlag = pts.filter(p => p.flagged).length;
  let text = lightCurve.weak
    ? 'Nothing bright at this spot, so these values are mostly noise.'
    : max / Math.max(min, 1e-3) > 1.4
      ? `Brightness changes a lot: the brightest date is ${(max / Math.max(min, 1e-3)).toFixed(1)}× the faintest.`
      : 'Brightness stays about the same across these dates.';
  if (nFlag) text += ` ${nFlag} date${nFlag === 1 ? ' has' : 's have'} flagged pixels in the measured spot (triangles), so treat ${nFlag === 1 ? 'it' : 'them'} with care.`;
  text += lightCurve.supplied ? '' : ' Measured from the display images, so values are relative.';
  els.lcSummary.textContent = text;
  highlightChart();
}

function highlightChart() {
  const ring = document.getElementById('lc-current');
  const p = lightCurve.find(l => l.vi === state.frame);
  if (!ring) return;
  ring.style.display = p && state.req.mode !== 'stack' ? '' : 'none';
  if (p) { ring.setAttribute('cx', chart.x(p.mjd)); ring.setAttribute('cy', chart.y(p.rel)); }
}

els.lcSvg.addEventListener('pointermove', (e) => {
  const g = e.target.closest('.lc-pt');
  if (!g) { els.lcTip.hidden = true; return; }
  const p = lightCurve.find(l => l.vi === Number(g.dataset.vi));
  els.lcTip.innerHTML = `<strong class="mono">${mjdToDate(p.mjd)}</strong><br>${lightCurve.weak ? 'Counts' : 'Brightness'} ${p.rel.toFixed(2)}${p.flagged ? '<br>⚠ flagged pixels' : ''}`;
  const box = els.lcSvg.getBoundingClientRect();
  els.lcTip.style.left = `${((chart.x(p.mjd) / 640) * box.width).toFixed(0)}px`;
  els.lcTip.style.top = `${((chart.y(p.rel) / 220) * box.height).toFixed(0)}px`;
  els.lcTip.hidden = false;
});
els.lcSvg.addEventListener('pointerleave', () => { els.lcTip.hidden = true; });
els.lcSvg.addEventListener('click', (e) => {
  const g = e.target.closest('.lc-pt');
  if (!g) return;
  if (state.req.mode === 'stack') setMode('each');
  stopBlink(); state.frame = Number(g.dataset.vi); render();
});
els.lcReset.addEventListener('click', () => { state.aperture = null; computeLightCurve(); render(); });

// ---------- timeline ----------

function renderTimeline() {
  const n = state.view.length;
  const every = Math.ceil(n / (innerWidth < 600 ? 3 : 6));   // with many dates, label only some
  els.tlTicks.replaceChildren(...state.view.map((fi, i) => {
    const f = patch().frames[fi];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tl-tick' + (i % every && i !== n - 1 ? ' tl-hide-label' : '');
    b.style.left = n > 1 ? `${(i / (n - 1)) * 100}%` : '50%';
    b.setAttribute('aria-label', `Show image from ${mjdToDate(f.mjd)}`);
    b.innerHTML = `<span>${mjdToShort(f.mjd)}</span>`;
    b.addEventListener('click', () => { stopBlink(); state.frame = i; render(); });
    return b;
  }));
}

// ---------- right: AI predictions ----------

function predictions() {
  const p = patch();
  if (!p) return [];
  if (p.predictions) return p.predictions;
  const groups = new Map();
  for (const c of p.candidates || []) {
    const key = c.match?.name || 'Unknown mover';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ epoch: Number(String(c.seen_in).replace(/\D/g, '')), x: c.x, y: c.y });
  }
  return [...groups].map(([label, track], i) => ({ id: String(i), label, kind: 'Candidate', confidence: null, track }));
}

function renderPredictions() {
  const list = predictions();
  if (!list.length) {
    els.aiList.innerHTML = '<li class="ai-note">No candidates for this patch yet.</li>';
    return;
  }
  const scale = state.geom.scale;
  els.aiList.replaceChildren(...list.map(p => {
    const li = document.createElement('li');
    li.className = 'ai-item';
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(state.selected === p.id));
    const first = p.track[0], last = p.track.at(-1);
    const px = Math.hypot(last.x - first.x, last.y - first.y);
    const motion = p.track.length > 1 && px > 0.5 ? `moved ≈ ${Math.round(px * scale)}″`
      : p.track.length === 1 ? 'seen on one date' : 'stays in place';
    const conf = p.confidence == null ? null : Math.round(p.confidence * 100);
    b.innerHTML = `
      <span class="ai-row"><strong></strong><span class="mono small">${conf == null ? '—' : conf + '%'}</span></span>
      ${conf == null ? '' : `<span class="conf" aria-hidden="true"><i style="width:${conf}%"></i></span>`}
      <span class="ai-kind"></span>`;
    b.querySelector('strong').textContent = p.label;
    b.querySelector('.ai-kind').textContent = `${p.kind} · ${motion}`;
    b.addEventListener('click', () => {
      state.selected = state.selected === p.id ? null : p.id;
      renderPredictions();
      render();
    });
    li.append(b);
    return li;
  }));
}

// ---------- layers ----------

function renderOverlayNote() {
  const notes = [];
  for (const [key, box] of [['gaia', els.ovGaia], ['wise', els.ovWise]]) {
    if (box.checked) notes.push(SkyData.getOverlay(key, { patch: patch(), target: state.target }).note);
  }
  if (els.showTrack.checked) {
    notes.push(state.target ? 'Dashed orange circle: where the target should be on this date, from its proper motion.'
      : 'Expected positions are only known for the test targets.');
  }
  els.overlayNote.textContent = [...new Set(notes)].join(' ');
}

// ---------- URL: the page state is always shareable ----------

function syncUrl() {
  const r = state.req;
  const q = new URLSearchParams(location.search);
  const set = (k, v, def) => (v == null || v === def ? q.delete(k) : q.set(k, v));
  set('fov', +r.fov.toFixed(4));
  set('det', r.det, 'all');
  set('mode', r.mode, 'each');
  set('ref', r.mode === 'diff' ? r.ref : null, 'first');
  for (const [k, box] of [['flags', els.showFlags], ['gaia', els.ovGaia], ['wise', els.ovWise], ['track', els.showTrack]]) {
    set(k, box.checked ? '1' : null);
  }
  history.replaceState(null, '', `${location.pathname}?${q}`);
  els.openFull.href = location.href.replace(/([?&])embed=1&?/, '$1').replace(/[?&]$/, '');
}

function embedCode() {
  const u = new URL(location.href);
  u.searchParams.set('embed', '1');
  return `<iframe src="${u}" title="SkyBlink: ${state.req.name}" width="720" height="900" style="border:0;max-width:100%" loading="lazy"></iframe>`;
}

// ---------- loading and empty states ----------

function showEmpty(title, text, actions = []) {
  els.viewer.hidden = true;
  els.empty.hidden = false;
  els.emptyTitle.textContent = title;
  els.emptyDetail.textContent = text;
  els.emptyActions.replaceChildren(...actions.map(([labelText, href, primary]) => {
    const a = document.createElement(typeof href === 'function' ? 'button' : 'a');
    a.className = 'btn' + (primary ? ' primary' : '');
    a.textContent = labelText;
    if (typeof href === 'function') { a.type = 'button'; a.addEventListener('click', href); } else a.href = href;
    return a;
  }));
}

const demo = TARGETS.find(t => t.id === 'wise0855');
const demoAction = ['Open the WISE 0855 demo', viewerUrl({ ...demo, fov: demo.fov })];

// Live processing progress: "Step 2 of 4 · Downloading and cleaning SPHEREx images (14 of 36)".
// The bar spreads the four steps over 0-100%, with downloading (the slow part) taking most of it.
const STEP_SPAN = { 1: [0, 8], 2: [8, 85], 3: [85, 93], 4: [93, 100] };
function showStage(info) {
  if (info.wake) {
    els.loadingText.textContent = `${info.message}…`;
    els.loadingBar.style.width = '3%';
    els.loadingDetail.textContent = 'It runs on free hosting that sleeps after about 15 minutes without visitors, ' +
      'so the first search after a quiet spell waits up to a minute while it starts. After that it stays awake.';
    setStatus(`${info.message}…`);
    return;
  }
  const [a, b] = STEP_SPAN[info.step] || [0, 100];
  const frac = info.total ? info.done / info.total : 0;
  const count = info.total ? ` (${info.done} of ${info.total})` : '';
  els.loadingText.textContent = `Step ${info.step} of ${info.steps} · ${info.message}${count}`;
  els.loadingBar.style.width = `${a + (b - a) * frac}%`;
  els.loadingDetail.textContent = `No one has looked at this spot before, so we're processing it now from NASA's archive ` +
    `(${info.elapsed_s} s so far; usually 20 to 50 s). It's saved after this, so next time it opens instantly.`;
  setStatus(`${info.message}…`);
}

async function load() {
  const r = state.req;
  els.empty.hidden = true;
  els.viewer.hidden = false;
  els.loading.hidden = false;
  els.loadingText.textContent = 'Finding SPHEREx images for this spot…';
  els.loadingDetail.textContent = '';
  els.loadingBar.style.width = '0%';
  setStatus('Loading sky images…');
  let res;
  try {
    res = await SkyData.getPatch(r, {
      onStage(info) { showStage(info); },
      onProgress(done, total) {
        els.loadingText.textContent = `Loading image ${done} of ${total}…`;
        els.loadingDetail.textContent = '';
        els.loadingBar.style.width = `${(done / total) * 100}%`;
      },
    });
  } catch (err) {
    console.error(err);
    setStatus('');
    els.loading.hidden = true;
    showEmpty('We couldn\'t load the sky images',
      'The image server didn\'t answer, or the connection dropped. Nothing is wrong with your coordinates.',
      [['Try again', () => load(), true], demoAction]);
    return;
  }
  els.loading.hidden = true;
  setStatus('');

  if (res.status === 'no-coverage') {
    const near = res.nearest;
    const actions = [];
    if (near) actions.push([`Open nearest: ${near.title}`, viewerUrl({ ra: near.ra, dec: near.dec, fov: r.fov, name: near.title.replace(/ \(simulated\)$/, '') }), true]);
    actions.push(demoAction);
    showEmpty('No SPHEREx images for this spot yet',
      `Nothing in our image set covers RA ${formatRA(r.ra)}, Dec ${formatDec(r.dec)}.` +
      (near ? ` The nearest patch we have is ${near.title}, ${near.sepDeg.toFixed(1)}° away.` : '') +
      (res.liveUnavailable || SkyData.config.source === 'static'
        ? ' The live SPHEREx server that processes new spots could not be reached (it may be restarting, or not set up yet), so right now only the 100 pre-processed targets open. Try again in a minute.'
        : ' New SPHEREx data arrives every few weeks, so check back.'),
      actions);
    return;
  }

  state.data = res;
  pixelCache = []; maskCache = []; flagLayers = []; sourceCache = new Map();
  state.selected = null;
  state.aperture = null;
  state.geom = makeGeom();
  if (res.failed.length) setStatus(`${res.failed.length} of ${res.failed.length + res.patch.frames.length} images could not be loaded and were skipped.`);
  const p = res.patch.patch || {};
  els.simBadge.hidden = !p.simulated;
  els.simBadge.textContent = p.boost && p.boost !== 1 ? `Simulated · motion ×${p.boost}` : 'Simulated data';
  renderDetectors();
  applyDetector();
  renderPredictions();
}

// ---------- detectors ----------

function availableDetectors() {
  return new Set(patch().frames.map(f => String(f.detector ?? 'all')));
}

function renderDetectors() {
  const have = availableDetectors();
  els.det.replaceChildren(...DETECTORS.map(d => {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = have.has(d.id) ? d.label : `${d.label} (not in this data yet)`;
    o.disabled = !have.has(d.id);
    return o;
  }));
  if (!have.has(state.req.det)) state.req.det = [...have][0];
  els.det.value = state.req.det;
}

function applyDetector() {
  stopBlink();
  const det = state.req.det;
  state.view = patch().frames.map((f, i) => [String(f.detector ?? 'all'), i]).filter(([d]) => d === det).map(([, i]) => i);
  state.frame = 0;
  sourceCache = new Map();
  renderTimeline();
  renderRawPatch();
  computeLightCurve();
  renderOverlayNote();
  updateModeHelp();
  syncUrl();
  render();
}

// ---------- playback ----------

function startBlink() {
  if (!state.data || state.view.length < 2 || state.req.mode === 'stack') return;
  clearInterval(state.timer);          // never run two timers at once
  state.playing = true;
  state.timer = setInterval(() => {
    state.frame = (state.frame + 1) % state.view.length;
    render();                            // instant swap: no fade, no blank frame
  }, Math.max(MIN_SWAP_MS, SPEED_MS[state.speed]));
  render();
}

function stopBlink() {
  clearInterval(state.timer);
  state.timer = null;
  state.playing = false;
  if (state.data) render();
}

function step(delta) {
  if (!state.data || state.req.mode === 'stack') return;
  stopBlink();
  const n = state.view.length;
  state.frame = (state.frame + delta + n) % n;
  render();
}

function setMode(mode) {
  state.req.mode = mode;
  for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === mode;
  if (mode === 'stack') stopBlink();
  updateModeHelp();
  syncUrl();
  render();
}

function updateModeHelp() {
  els.refWrap.hidden = state.req.mode !== 'diff';
  let text = MODE_HELP[state.req.mode];
  if (state.data && state.view.length < 2) text = 'Only one date here so far, so there is nothing to compare yet. New SPHEREx passes add a date every six months.';
  els.modeHelp.textContent = text;
}

// ---------- go-to bar ----------

function renderGoto() {
  els.gFov.replaceChildren(...FOV_OPTIONS.map(o => new Option(o.label, o.deg)));
  // keep a custom fov from the URL selectable
  if (!FOV_OPTIONS.some(o => Math.abs(o.deg - state.req?.fov) < 1e-6) && state.req) {
    els.gFov.append(new Option(formatFov(state.req.fov), state.req.fov));
  }
  els.gFov.value = state.req ? String(FOV_OPTIONS.find(o => Math.abs(o.deg - state.req.fov) < 1e-6)?.deg ?? state.req.fov) : String(15 / 60);
  if (state.req) {
    els.gRa.value = formatRA(state.req.ra);
    els.gDec.value = formatDec(state.req.dec);
  }
  els.presetList.replaceChildren(...TARGETS.map(t => {
    const a = document.createElement('a');
    a.className = 'btn preset';
    a.href = viewerUrl({ ra: t.ra, dec: t.dec, fov: t.fov, name: t.name });
    if (state.target?.id === t.id) a.setAttribute('aria-current', 'true');
    a.innerHTML = `<span></span><span class="preset-kind">${t.kind === 'mover' ? 'moves' : 'varies'}</span>`;
    a.firstChild.textContent = t.name;
    return a;
  }));
}

els.gotoForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const ra = parseRA(els.gRa.value), dec = parseDec(els.gDec.value);
  els.gRa.setAttribute('aria-invalid', String(ra === null));
  els.gDec.setAttribute('aria-invalid', String(dec === null));
  if (ra === null || dec === null) {
    els.gotoError.textContent = ra === null
      ? 'Right Ascension should look like 133.795 (degrees) or 08h55m10s (hours).'
      : 'Declination should be between −90 and +90, like -7.245 or -7d14m42s.';
    (ra === null ? els.gRa : els.gDec).focus();
    return;
  }
  const keep = Object.fromEntries(['embed', 'source', 'layers', 'gaia', 'wise'].map(k => [k, new URLSearchParams(location.search).get(k)]));
  location.href = viewerUrl({ ra, dec, fov: Number(els.gFov.value), name: knownTarget(ra, dec)?.name, ...keep });
});

// Changing the field of view re-crops instantly when the data already covers it.
els.gFov.addEventListener('change', () => {
  if (!state.req) return;
  state.req.fov = Number(els.gFov.value);
  syncUrl();
  updateTitle();
  if (!state.data) return;
  state.geom = makeGeom();
  renderRawPatch();
  setStatus(state.geom.limited
    ? `This sample patch only covers ${formatFov(state.geom.size * state.geom.scale / 3600)}, so that's all we can show. Wider fields need the live data service.`
    : '');
  render();
});

// ---------- events ----------

els.frame.addEventListener('input', () => { state.frame = Number(els.frame.value); stopBlink(); });
els.blink.addEventListener('click', () => { state.playing ? stopBlink() : startBlink(); });
els.prev.addEventListener('click', () => step(-1));
els.next.addEventListener('click', () => step(1));
canvas.addEventListener('mousemove', renderCursor);
canvas.addEventListener('click', (e) => {
  if (!state.data) return;
  const p = canvasToPx(e);
  state.aperture = { x: Math.round(p.x), y: Math.round(p.y) };
  computeLightCurve();
  render();
});

els.speed.value = state.speed;
els.speed.addEventListener('change', () => {
  state.speed = els.speed.value;
  if (state.playing) startBlink();
});

for (const r of document.querySelectorAll('input[name="mode"]')) {
  r.addEventListener('change', () => setMode(r.value));
}
els.ref.addEventListener('change', () => { state.req.ref = els.ref.value; syncUrl(); render(); });
els.det.addEventListener('change', () => { state.req.det = els.det.value; applyDetector(); });

for (const el of [els.stretch, els.contrast, els.invert, els.crosshair]) el.addEventListener('input', applyFilters);
for (const el of [els.showFlags, els.ovGaia, els.ovWise, els.showTrack]) {
  el.addEventListener('change', () => { renderOverlayNote(); syncUrl(); render(); });
}
els.reveal.addEventListener('change', () => { state.revealed = els.reveal.checked; render(); });

async function copy(btn, text, done) {
  const old = btn.textContent;
  try { await navigator.clipboard.writeText(text); btn.textContent = done; } catch { btn.textContent = 'Copy failed'; }
  setTimeout(() => { btn.textContent = old; }, 1600);
}
els.copyLink.addEventListener('click', () => copy(els.copyLink, location.href.replace(/([?&])embed=1&?/, '$1'), 'Link copied'));
els.copyEmbed.addEventListener('click', () => copy(els.copyEmbed, embedCode(), 'Embed code copied'));

// Keyboard shortcuts anywhere on the page, except while typing or using a control.
document.addEventListener('keydown', (e) => {
  if (!state.data || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.target.closest('input, select, textarea, button, summary, a')) return;
  if (e.key === ' ') { e.preventDefault(); state.playing ? stopBlink() : startBlink(); }
  if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  if (e.key === 'Enter' && e.target === canvas) { state.aperture = null; computeLightCurve(); render(); }
});

// ---------- start ----------

function updateTitle() {
  const r = state.req;
  els.targetCoords.textContent = `RA ${formatRA(r.ra)} · Dec ${formatDec(r.dec)} · ${formatFov(r.fov)} field`;
  els.fovBadge.textContent = formatFov(r.fov);
}

(function start() {
  applyFilters();
  const q = new URLSearchParams(location.search);
  const ra = parseRA(q.get('ra') ?? '');
  const dec = parseDec(q.get('dec') ?? '');

  if (ra === null || dec === null) {
    renderGoto();
    els.viewerTitle.textContent = 'Pick a patch of sky';
    showEmpty('Pick a patch of sky', 'Type coordinates above, or pick one of the five test targets.', []);
    return;
  }

  state.target = knownTarget(ra, dec);
  const fov = Number(q.get('fov')) || state.target?.fov || 0.25;
  const mode = ['each', 'stack', 'diff'].includes(q.get('mode')) ? q.get('mode') : 'each';
  const ref = ['first', 'prev', 'stack'].includes(q.get('ref')) ? q.get('ref') : 'first';
  const name = q.get('name') || state.target?.name || 'Patch of sky';
  state.req = { ra, dec, fov, name, det: q.get('det') || 'all', mode, ref };

  els.showFlags.checked = q.get('flags') === '1';
  els.ovGaia.checked = q.get('gaia') === '1';
  els.ovWise.checked = q.get('wise') === '1';
  els.showTrack.checked = q.has('track') ? q.get('track') === '1' : state.target?.kind === 'mover';
  els.ref.value = ref;
  for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === mode;

  renderGoto();
  els.viewerTitle.textContent = name;
  document.title = `SkyBlink · ${name}`;
  updateTitle();
  if (state.target) {
    const t = state.target;
    const yrs = new Date().getUTCFullYear() + new Date().getUTCMonth() / 12 - t.epoch;
    const moved = Math.hypot(...t.pm) * yrs / 60;
    els.targetNote.hidden = false;
    els.targetNote.textContent = t.note + (moved > 0.2
      ? ` It has moved about ${moved.toFixed(1)}′ since its ${t.epoch} catalogue position, so it is not under the crosshair: the dashed orange circle shows where it should be on each date.`
      : '');
  }
  els.domeLink.href = `dome.html?${new URLSearchParams({ ra: ra.toFixed(5), dec: dec.toFixed(5), fov, name })}`;
  if (EMBED) { els.openFull.hidden = false; els.copyEmbed.hidden = true; }
  els.openFull.href = location.href.replace(/([?&])embed=1&?/, '$1').replace(/[?&]$/, '');
  load();
})();
