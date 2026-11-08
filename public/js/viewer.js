// Viewer page: viewer.html?ra=133.795&dec=-7.245&fov=0.25[&name=WISE+0855]
// Left: raw data · Center: image + blink · Bottom: timeline · Right: AI predictions.
// Shared helpers (parseRA, formatRA, loadJSON, mjdToDate, ...) live in common.js.

const state = {
  patches: [],      // the list from data/patches.json
  patch: null,      // the open patch's data file, e.g. data/demo.json
  jsonUrl: null,
  frame: 0,         // which date is showing
  playing: false,   // is the blink running?
  revealed: false,  // circle every candidate?
  selected: null,   // id of the highlighted AI prediction
  mode: 'normal',   // 'normal' or 'diff' (this date minus the first date)
  speed: 'normal',
  timer: null,
  target: null,     // { ra, dec, fov, name } from the URL
};

let images = [];    // decoded <img> per frame
let pixels = [];    // ImageData per frame, made on first use
let flagLayers = []; // red overlay canvas per frame, from frames[].flags_file (null if none)

const $ = (s) => document.querySelector(s);
const els = {
  title:     $('#viewer-title'),
  coords:    $('#target-coords'),
  copyLink:  $('#copy-link'),
  empty:     $('#empty'),
  emptyText: $('#empty-detail'),
  viewer:    $('#viewer'),
  stage:     $('#stage'),
  canvas:    $('#sky'),
  simBadge:  $('#sim-badge'),
  badge:     $('#frame-badge'),
  countBadge:$('#count-badge'),
  loading:   $('#loading'),
  prev:      $('#prev'),
  next:      $('#next'),
  blink:     $('#blink'),
  speed:     $('#speed'),
  modeHelp:  $('#mode-help'),
  stretch:   $('#stretch'),
  contrast:  $('#contrast'),
  invert:    $('#invert'),
  crosshair: $('#crosshair'),
  frame:     $('#frame'),
  frameDate: $('#frame-date'),
  ticks:     $('#tl-ticks'),
  domeLink:  $('#dome-link'),
  rawFrame:  $('#raw-frame'),
  rawCursor: $('#raw-cursor'),
  rawPatch:  $('#raw-patch'),
  download:  $('#download'),
  aiList:    $('#ai-list'),
  reveal:    $('#reveal'),
  showFlags: $('#show-flags'),
  status:    $('#status'),
};

const SPEED_MS = { slow: 1000, normal: 500, fast: 250 };
const DISPLAY_PX = 768;   // draw at least this big so markers stay crisp

function setStatus(text) { els.status.textContent = text; }

function fillDL(dl, rows) {
  dl.replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    return [dt, dd];
  }));
}

// Arcseconds per pixel: from the data file if given, else worked out from the field of view.
function pixelScale() {
  const p = state.patch?.patch || {};
  if (p.pixel_scale_arcsec) return p.pixel_scale_arcsec;
  const fov = p.fov_deg || state.target.fov;
  return p.width_px ? (fov * 3600) / p.width_px : null;
}

// ---------- drawing ----------

function getPixels(i) {
  if (!pixels[i]) {
    const img = images[i];
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    pixels[i] = ctx.getImageData(0, 0, c.width, c.height);
  }
  return pixels[i];
}

function frameSource(i) {
  if (state.mode !== 'diff') return images[i];
  // Difference: this date minus the first date. Grey = no change, bright = new, dark = gone.
  const a = getPixels(i), b = getPixels(0);
  const out = new ImageData(a.width, a.height);
  for (let p = 0; p < a.data.length; p += 4) {
    out.data[p]     = 128 + (a.data[p]     - b.data[p]);
    out.data[p + 1] = 128 + (a.data[p + 1] - b.data[p + 1]);
    out.data[p + 2] = 128 + (a.data[p + 2] - b.data[p + 2]);
    out.data[p + 3] = 255;
  }
  const c = document.createElement('canvas');
  c.width = a.width; c.height = a.height;
  c.getContext('2d').putImageData(out, 0, 0);
  return c;
}

function drawFrame(i) {
  const img = images[i];
  const w = img.naturalWidth, h = img.naturalHeight;
  const k = Math.max(1, Math.ceil(DISPLAY_PX / Math.max(w, h)));   // whole-number zoom keeps pixels square
  const ctx = els.canvas.getContext('2d');
  els.canvas.width = w * k;
  els.canvas.height = h * k;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(frameSource(i), 0, 0, w * k, h * k);
  return k;
}

function drawMarker(ctx, x, y, { color = '#ffc857', dashed = false } = {}) {
  const r = Math.max(6, ctx.canvas.width * 0.035);
  ctx.save();
  ctx.lineWidth = Math.max(2, r / 6);
  ctx.strokeStyle = color;
  if (dashed) ctx.setLineDash([r / 2, r / 3]);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// Turn a 0/255 mask image into a see-through red layer.
function makeFlagLayer(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  for (let p = 0; p < d.data.length; p += 4) {
    const on = d.data[p] > 0;
    d.data[p] = 255; d.data[p + 1] = 60; d.data[p + 2] = 60; d.data[p + 3] = on ? 200 : 0;
  }
  ctx.putImageData(d, 0, 0);
  return c;
}

function drawOverlays(k) {
  const ctx = els.canvas.getContext('2d');
  const at = (v) => (v + 0.5) * k;

  if (els.showFlags.checked && flagLayers[state.frame]) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(flagLayers[state.frame], 0, 0, els.canvas.width, els.canvas.height);
  }

  if (state.revealed) {
    for (const p of predictions()) {
      const pt = p.track.find(t => t.epoch === state.frame);
      if (pt) drawMarker(ctx, at(pt.x), at(pt.y), { color: '#ffc857aa', dashed: true });
    }
  }

  const sel = predictions().find(p => p.id === state.selected);
  if (!sel) return;
  if (sel.track.length > 1) {                       // the path across all dates
    ctx.save();
    ctx.strokeStyle = '#ffc857';
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = Math.max(1.5, k / 3);
    ctx.setLineDash([k * 1.5, k]);
    ctx.beginPath();
    sel.track.forEach((t, i) => ctx[i ? 'lineTo' : 'moveTo'](at(t.x), at(t.y)));
    ctx.stroke();
    ctx.restore();
  }
  const pt = sel.track.find(t => t.epoch === state.frame);
  if (pt) drawMarker(ctx, at(pt.x), at(pt.y));
}

function applyFilters() {
  const b = els.stretch.value, c = els.contrast.value, inv = els.invert.checked ? 1 : 0;
  els.canvas.style.filter = `brightness(${b}) contrast(${c}) invert(${inv})`;
  els.stage.classList.toggle('no-crosshair', !els.crosshair.checked);
}

function render() {
  const patch = state.patch;
  if (!patch || !images.length) return;
  const frame = patch.frames[state.frame];
  const k = drawFrame(state.frame);
  drawOverlays(k);

  const date = mjdToDate(frame.mjd);
  const n = patch.frames.length;
  els.frame.max = n - 1;
  els.frame.value = state.frame;
  els.frameDate.textContent = `${date} · image ${state.frame + 1} of ${n}`;
  els.badge.textContent = state.mode === 'diff' ? `${date} − ${mjdToDate(patch.frames[0].mjd)}` : date;
  els.countBadge.textContent = `${state.frame + 1} / ${n}`;
  els.blink.setAttribute('aria-pressed', String(state.playing));
  els.blink.textContent = state.playing ? 'Pause' : 'Blink';
  for (const [i, b] of [...els.ticks.children].entries()) {
    b.setAttribute('aria-current', String(i === state.frame));
  }
  renderRawFrame(frame);
}

// ---------- left panel: raw data ----------

function renderRawFrame(frame) {
  fillDL(els.rawFrame, [
    ['Date', mjdToDate(frame.mjd)],
    ['MJD', frame.mjd.toFixed(3)],
    ['Band', frame.band || '—'],
    ['Flags', frame.flags?.length ? frame.flags.join(', ') : 'none'],
    ['File', frame.file.split('/').pop()],
  ]);
  els.download.href = new URL(frame.file, state.jsonUrl);
}

function renderRawPatch() {
  const p = state.patch.patch || {};
  const t = state.target;
  const scale = pixelScale();
  fillDL(els.rawPatch, [
    ['RA (deg)', t.ra.toFixed(5)],
    ['Dec (deg)', t.dec.toFixed(5)],
    ['Field', `${t.fov}°`],
    ['Size', p.width_px ? `${p.width_px}×${p.height_px} px` : '—'],
    ['Pixel', scale ? `${scale.toFixed(2)}″` : '—'],
    ['Dates', state.patch.frames.length],
    ['Span', `${mjdToDate(state.patch.frames[0].mjd)} → ${mjdToDate(state.patch.frames.at(-1).mjd)}`],
  ]);
}

function renderCursor(e) {
  if (!images.length) return;
  const img = images[state.frame];
  const r = els.canvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left) / r.width * img.naturalWidth);
  const y = Math.floor((e.clientY - r.top) / r.height * img.naturalHeight);
  if (x < 0 || y < 0 || x >= img.naturalWidth || y >= img.naturalHeight) return;
  const idx = (y * img.naturalWidth + x) * 4;
  const v = getPixels(state.frame).data[idx];
  const v0 = getPixels(0).data[idx];
  const scale = pixelScale();
  const cx = img.naturalWidth / 2, cy = img.naturalHeight / 2;
  fillDL(els.rawCursor, [
    ['Pixel', `${x}, ${y}`],
    ['Value', v],
    ['Δ vs first', (v - v0 > 0 ? '+' : '') + (v - v0)],
    ['From center', scale ? `${((x + 0.5 - cx) * scale).toFixed(0)}″, ${((cy - y - 0.5) * scale).toFixed(0)}″` : '—'],
  ]);
}

// ---------- bottom: timeline ----------

function renderTimeline() {
  const frames = state.patch.frames;
  const n = frames.length;
  const every = Math.ceil(n / 6);                  // with many dates, label only some
  els.ticks.replaceChildren(...frames.map((f, i) => {
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

// Use `predictions` from the data file when the model provides them.
// Otherwise fall back to grouping `candidates` (same match name = same object).
function predictions() {
  const patch = state.patch;
  if (!patch) return [];
  if (patch.predictions) return patch.predictions;
  const groups = new Map();
  for (const c of patch.candidates || []) {
    const key = c.match?.name || 'Unknown mover';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ epoch: Number(String(c.seen_in).replace(/\D/g, '')), x: c.x, y: c.y });
  }
  return [...groups].map(([label, track], i) => ({
    id: String(i), label, kind: 'Candidate', confidence: null, track,
  }));
}

function renderPredictions() {
  const list = predictions();
  if (!list.length) {
    els.aiList.innerHTML = '<li class="ai-note">No candidates for this patch yet.</li>';
    return;
  }
  const scale = pixelScale();
  els.aiList.replaceChildren(...list.map(p => {
    const li = document.createElement('li');
    li.className = 'ai-item';
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(state.selected === p.id));
    const first = p.track[0], last = p.track.at(-1);
    const px = Math.hypot(last.x - first.x, last.y - first.y);
    const motion = p.track.length > 1 && px > 0.5
      ? `moved ≈ ${scale ? Math.round(px * scale) + '″' : px.toFixed(1) + ' px'}`
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

// ---------- loading ----------

function findPatch(ra, dec, fov) {
  let best = null;
  for (const p of state.patches) {
    if (p.ra == null || p.dec == null) continue;
    const d = separation(ra, dec, p.ra, p.dec);
    if (d <= fov / 2 && (!best || d < best.d)) best = { ...p, d };
  }
  return best;
}

function showEmpty(text) {
  els.viewer.hidden = true;
  els.empty.hidden = false;
  els.emptyText.textContent = text;
}

async function openPatch(id) {
  els.viewer.hidden = false;
  els.loading.hidden = false;
  setStatus('Loading sky images…');
  try {
    const jsonUrl = new URL(`data/${id}.json`, location.href);
    const patch = await loadJSON(jsonUrl);
    images = await Promise.all(patch.frames.map(f => loadImage(new URL(f.file, jsonUrl))));
    pixels = [];
    flagLayers = await Promise.all(patch.frames.map(f => f.flags_file
      ? loadImage(new URL(f.flags_file, jsonUrl)).then(makeFlagLayer).catch(() => null)
      : null));
    Object.assign(state, { patch, jsonUrl, frame: 0, selected: null });
    els.simBadge.hidden = !patch.patch?.simulated;
    renderTimeline();
    renderRawPatch();
    renderPredictions();
    setStatus('');
    render();
  } catch (err) {
    console.error(err);
    setStatus('');
    showEmpty('We could not load the sky images. Check your connection and try again.');
  } finally {
    els.loading.hidden = true;
  }
}

// ---------- blink ----------

function startBlink() {
  if (!state.patch) return;
  clearInterval(state.timer);          // never run two timers at once
  state.playing = true;
  state.timer = setInterval(() => {
    state.frame = (state.frame + 1) % state.patch.frames.length;
    render();
  }, SPEED_MS[state.speed]);
  render();
}

function stopBlink() {
  clearInterval(state.timer);
  state.timer = null;
  state.playing = false;
  render();
}

function step(delta) {
  if (!state.patch) return;
  stopBlink();
  const n = state.patch.frames.length;
  state.frame = (state.frame + delta + n) % n;
  render();
}

// ---------- events ----------

els.frame.addEventListener('input', () => {
  state.frame = Number(els.frame.value);
  stopBlink();
});
els.blink.addEventListener('click', () => { state.playing ? stopBlink() : startBlink(); });
els.prev.addEventListener('click', () => step(-1));
els.next.addEventListener('click', () => step(1));
els.canvas.addEventListener('click', () => step(1));
els.canvas.addEventListener('mousemove', renderCursor);

els.speed.addEventListener('change', () => {
  state.speed = els.speed.value;
  if (state.playing) startBlink();
});

for (const r of document.querySelectorAll('input[name="mode"]')) {
  r.addEventListener('change', () => {
    state.mode = r.value;
    els.modeHelp.textContent = state.mode === 'diff'
      ? 'Each date minus the first. Grey = unchanged, bright = appeared, dark = vanished.'
      : 'Each date as observed.';
    render();
  });
}

for (const el of [els.stretch, els.contrast, els.invert, els.crosshair]) {
  el.addEventListener('input', applyFilters);
}
els.reveal.addEventListener('change', () => { state.revealed = els.reveal.checked; render(); });
els.showFlags.addEventListener('change', render);

els.copyLink.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    els.copyLink.textContent = 'Link copied';
  } catch {
    els.copyLink.textContent = 'Copy failed';
  }
  setTimeout(() => { els.copyLink.textContent = 'Copy link'; }, 1600);
});

// Keyboard shortcuts anywhere on the page, except while typing or using a control.
document.addEventListener('keydown', (e) => {
  if (!state.patch || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.target.closest('input, select, textarea, button, summary, a')) return;
  if (e.key === ' ') { e.preventDefault(); state.playing ? stopBlink() : startBlink(); }
  if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  if (e.key === 'ArrowLeft')  { e.preventDefault(); step(-1); }
});

// ---------- start ----------

(async function start() {
  applyFilters();
  const q = new URLSearchParams(location.search);
  const ra = parseRA(q.get('ra') ?? '');
  const dec = parseDec(q.get('dec') ?? '');
  const fov = Number(q.get('fov')) || 0.25;

  if (ra === null || dec === null) {
    els.title.textContent = 'Pick a patch of sky';
    showEmpty('No coordinates were given. Use the Search Tool to choose a spot.');
    return;
  }

  const known = TARGETS.find(t => separation(ra, dec, t.ra, t.dec) < 0.01);
  const name = q.get('name') || known?.name || 'Patch of sky';
  state.target = { ra, dec, fov, name };
  els.title.textContent = name;
  document.title = `SkyBlink · ${name}`;
  els.coords.textContent = `RA ${formatRA(ra)} · Dec ${formatDec(dec)} · ${fov}° field`;
  els.domeLink.href = `dome.html?${new URLSearchParams({ ra: ra.toFixed(5), dec: dec.toFixed(5), fov, name })}`;

  try {
    state.patches = await loadJSON('data/patches.json');
  } catch {
    state.patches = [];
  }
  const hit = findPatch(ra, dec, fov);
  if (!hit) {
    showEmpty(`Nothing in our image set covers RA ${formatRA(ra)}, Dec ${formatDec(dec)} yet. ` +
              'New SPHEREx data arrives regularly. Check back after the next release, or try the demo.');
    return;
  }
  await openPatch(hit.id);
})();
