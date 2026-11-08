const state = {
  patches: [],      // the list from data/patches.json
  patch: null,      // the open patch's handshake file, e.g. data/demo.json
  frame: 0,         // which date is showing
  playing: false,   // is the blink running?
  revealed: false,  // circle known movers?
  mode: 'normal',   // 'normal' or 'diff' (this date minus the first date)
  speed: 'normal',
  timer: null,
  target: null,     // { ra, dec, fov } the user asked for
};

let images = [];    // decoded <img> per frame
let pixels = [];    // ImageData per frame, made on first use (for difference mode)

const $ = (s) => document.querySelector(s);
const els = {
  form:      $('#search'),
  ra:        $('#ra'),
  dec:       $('#dec'),
  fov:       $('#fov'),
  formError: $('#form-error'),
  presets:   $('#presets'),
  empty:     $('#empty'),
  emptyText: $('#empty-detail'),
  challenge: $('#challenge'),
  coords:    $('#target-coords'),
  copyLink:  $('#copy-link'),
  stage:     $('.stage'),
  canvas:    $('#sky'),
  simBadge:  $('#sim-badge'),
  badge:     $('#frame-badge'),
  loading:   $('#loading'),
  prev:      $('#prev'),
  next:      $('#next'),
  blink:     $('#blink'),
  speed:     $('#speed'),
  frame:     $('#frame'),
  frameDate: $('#frame-date'),
  frameCount:$('#frame-count'),
  modeHelp:  $('#mode-help'),
  stretch:   $('#stretch'),
  contrast:  $('#contrast'),
  invert:    $('#invert'),
  crosshair: $('#crosshair'),
  reveal:    $('#reveal'),
  meta:      $('#meta'),
  filmstrip: $('#filmstrip'),
  status:    $('#status'),
};

// Challenge targets (J2000). Each data file the pipeline makes goes in data/patches.json with ra/dec.
const TARGETS = [
  { id: 'wise0855', name: 'WISE 0855',      ra: 133.7951, dec: -7.2451 },
  { id: 'barnard',  name: "Barnard's Star", ra: 269.4521, dec: 4.6934 },
  { id: 'epsindib', name: 'Epsilon Indi B', ra: 331.0438, dec: -56.7827 },
  { id: 'rwaur',    name: 'RW Aurigae',     ra: 76.9563,  dec: 30.4013 },
  { id: 'rdra',     name: 'R Draconis',     ra: 248.1675, dec: 66.7551 },
];

const SPEED_MS = { slow: 1000, normal: 500, fast: 250 };
const DISPLAY_PX = 768;   // draw at least this big so markers stay crisp

// ---------- small helpers ----------

// The handshake file gives times as MJD (days since 1858-11-17). 40587 is 1970-01-01.
function mjdToDate(mjd) {
  return new Date((mjd - 40587) * 86400000).toISOString().slice(0, 10);   // "2025-05-01"
}

function setStatus(text) { els.status.textContent = text; }

async function loadJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function loadImage(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

function pad(n, w = 2, d = 0) { 
  return n.toFixed(d).padStart(w + (d ? d + 1 : 0), '0'); 
}

function formatRA(deg) {
  let s = deg / 15 * 3600;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);   s -= m * 60;
  return `${pad(h)}h${pad(m)}m${pad(s, 2, 2)}s`;
}

function formatDec(deg) {
  const sign = deg < 0 ? '−' : '+';
  let s = Math.abs(deg) * 3600;
  const d = Math.floor(s / 3600); s -= d * 3600;
  const m = Math.floor(s / 60);   s -= m * 60;
  return `${sign}${pad(d)}°${pad(m)}′${pad(s, 2, 1)}″`;
}

// Angle between two sky positions, in degrees.
function separation(ra1, dec1, ra2, dec2) {
  const r = Math.PI / 180;
  const c = Math.sin(dec1 * r) * Math.sin(dec2 * r) +
            Math.cos(dec1 * r) * Math.cos(dec2 * r) * Math.cos((ra1 - ra2) * r);
  return Math.acos(Math.min(1, Math.max(-1, c))) / r;
}

// ---------- coordinate parsing ----------

function parseAngle(text) {
  const t = text.trim().replace('−', '-');            // accept a typographic minus
  if (t === '') return null;

  const negative = t.startsWith('-');
  const cleaned = t
    .replace(/^[+-]/, '')
    .replace(/[hdms°′″'":]/gi, ' ')
    .trim();
  if (cleaned === '') return null;

  const parts = cleaned.split(/\s+/);
  if (parts.length > 3) return null;
  if (!parts.every(p => /^\d+(\.\d+)?$/.test(p))) return null;

  const [a, b = 0, c = 0] = parts.map(Number);
  if (b >= 60 || c >= 60) return null;

  return { negative, value: a + b / 60 + c / 3600, count: parts.length };
}

function parseRA(text) {
  const p = parseAngle(text);
  if (!p || p.negative) return null;
  const isHours = /[h:]/i.test(text) || p.count > 1;  // "08h55m..." or "08 55 10" means hours
  const deg = isHours ? p.value * 15 : p.value;
  return deg >= 0 && deg < 360 ? deg : null;
}

function parseDec(text) {
  const p = parseAngle(text);
  if (!p) return null;
  const deg = p.negative ? -p.value : p.value;
  return deg >= -90 && deg <= 90 ? deg : null;
}

// ---------- drawing ----------

function frameSource(i) {
  if (state.mode !== 'diff') return images[i];
  // Difference: this date minus the first date. Grey = no change, bright = new, dark = gone.
  const a = getPixels(i), b = getPixels(0);
  const out = new ImageData(a.width, a.height);
  for (let p = 0; p < a.data.length; p += 4) {
    const v = 128 + (a.data[p] - b.data[p]);
    const g = 128 + (a.data[p + 1] - b.data[p + 1]);
    const bl = 128 + (a.data[p + 2] - b.data[p + 2]);
    out.data[p] = v; out.data[p + 1] = g; out.data[p + 2] = bl; out.data[p + 3] = 255;
  }
  const c = document.createElement('canvas');
  c.width = a.width; c.height = a.height;
  c.getContext('2d').putImageData(out, 0, 0);
  return c;
}

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

function drawMarker(ctx, x, y) {
  const r = Math.max(6, ctx.canvas.width * 0.04);
  ctx.lineWidth = Math.max(2, r / 6);
  ctx.strokeStyle = '#ffc857';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
}

function drawCandidates(patch, frameIndex, k) {
  const ctx = els.canvas.getContext('2d');
  for (const c of patch.candidates || []) {
    if (c.seen_in === `e${frameIndex}`) drawMarker(ctx, (c.x + 0.5) * k, (c.y + 0.5) * k);
  }
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
  if (state.revealed) drawCandidates(patch, state.frame, k);

  const date = mjdToDate(frame.mjd);
  els.frame.max = patch.frames.length - 1;
  els.frame.value = state.frame;
  els.frameDate.textContent = date;
  els.badge.textContent = state.mode === 'diff' ? `${date} − ${mjdToDate(patch.frames[0].mjd)}` : date;
  els.frameCount.textContent = `Image ${state.frame + 1} of ${patch.frames.length}`;
  els.blink.setAttribute('aria-pressed', String(state.playing));
  els.blink.textContent = state.playing ? 'Pause' : 'Blink';
  for (const [i, b] of [...els.filmstrip.querySelectorAll('button')].entries()) {
    b.setAttribute('aria-current', String(i === state.frame));
  }
}

// ---------- page sections ----------

function renderPresets() {
  els.presets.replaceChildren(...TARGETS.map(t => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t.name;
    b.addEventListener('click', () => {
      els.ra.value = formatRA(t.ra);
      els.dec.value = formatDec(t.dec);
      els.form.requestSubmit();
    });
    b.dataset.ra = t.ra; b.dataset.dec = t.dec;
    return b;
  }));
}

function markPreset(ra, dec) {
  for (const b of els.presets.querySelectorAll('button')) {
    const hit = separation(ra, dec, +b.dataset.ra, +b.dataset.dec) < 0.01;
    b.setAttribute('aria-current', String(hit));
  }
}

function renderFilmstrip(patch, jsonUrl) {
  els.filmstrip.replaceChildren(...patch.frames.map((f, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', `Show image from ${mjdToDate(f.mjd)}`);
    const img = document.createElement('img');
    img.src = new URL(f.file, jsonUrl); img.alt = '';
    const cap = document.createElement('span');
    cap.textContent = mjdToDate(f.mjd);
    b.append(img, cap);
    b.addEventListener('click', () => { stopBlink(); state.frame = i; render(); });
    li.append(b);
    return li;
  }));
}

function renderMeta(patch) {
  const p = patch.patch || {};
  const first = mjdToDate(patch.frames[0].mjd);
  const last = mjdToDate(patch.frames.at(-1).mjd);
  const rows = [
    ['Dates', patch.frames.length],
    ['Span', `${first} → ${last}`],
    ['Image size', p.width_px ? `${p.width_px} × ${p.height_px} px` : '—'],
    ['Field of view', `${state.target.fov}°`],
    ['Known movers', (patch.candidates || []).filter(c => c.match).length ? 'yes' : 'none listed'],
  ];
  els.meta.replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    return [dt, dd];
  }));
}

// Find the closest data file that covers the requested spot.
function findPatch(ra, dec, fov) {
  let best = null;
  for (const p of state.patches) {
    if (p.ra == null || p.dec == null) continue;
    const d = separation(ra, dec, p.ra, p.dec);
    if (d <= fov / 2 && (!best || d < best.d)) best = { ...p, d };
  }
  return best;
}

async function openPatch(id) {
  els.challenge.hidden = false;
  els.loading.hidden = false;
  setStatus('Loading sky images…');
  try {
    const jsonUrl = new URL(`data/${id}.json`, location.href);
    const patch = await loadJSON(jsonUrl);
    images = await Promise.all(patch.frames.map(f => loadImage(new URL(f.file, jsonUrl))));
    pixels = [];
    Object.assign(state, { patch, frame: 0 });
    els.simBadge.hidden = !patch.patch?.simulated;
    renderFilmstrip(patch, jsonUrl);
    renderMeta(patch);
    setStatus('');
    render();
  } catch (err) {
    console.error(err);
    els.challenge.hidden = true;
    setStatus('');
    showEmpty('We could not load the sky images. Check your connection and try again.');
  } finally {
    els.loading.hidden = true;
  }
}

function showEmpty(text) {
  els.empty.hidden = false;
  els.emptyText.textContent = text;
}

async function search(ra, dec, fov, { updateUrl = true } = {}) {
  stopBlink();
  state.target = { ra, dec, fov };
  els.empty.hidden = true;
  els.coords.textContent = `RA ${formatRA(ra)}  ·  Dec ${formatDec(dec)}  ·  ${fov}° field`;
  markPreset(ra, dec);

  if (updateUrl) {
    const q = new URLSearchParams({ ra: ra.toFixed(5), dec: dec.toFixed(5), fov });
    history.replaceState(null, '', `?${q}`);
  }

  const hit = findPatch(ra, dec, fov);
  if (!hit) {
    els.challenge.hidden = true;
    showEmpty(`Nothing in our image set covers RA ${formatRA(ra)}, Dec ${formatDec(dec)} yet. ` +
              'Try one of the challenge targets above, or check back after the next SPHEREx data release.');
    return;
  }
  await openPatch(hit.id);
  els.challenge.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const ra = parseRA(els.ra.value);
  const dec = parseDec(els.dec.value);
  els.ra.setAttribute('aria-invalid', String(ra === null));
  els.dec.setAttribute('aria-invalid', String(dec === null));
  if (ra === null || dec === null) {
    els.formError.textContent = ra === null
      ? 'Right Ascension should look like 133.795 (degrees) or 08h55m10s (hours).'
      : 'Declination should be between −90 and +90, like -7.245 or -7d14m42s.';
    (ra === null ? els.ra : els.dec).focus();
    return;
  }
  els.formError.textContent = '';
  search(ra, dec, Number(els.fov.value));
});

els.frame.addEventListener('input', () => {
  state.frame = Number(els.frame.value);
  stopBlink();
});

els.blink.addEventListener('click', () => { state.playing ? stopBlink() : startBlink(); });
els.prev.addEventListener('click', () => step(-1));
els.next.addEventListener('click', () => step(1));
els.canvas.addEventListener('click', () => step(1));

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

els.copyLink.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    els.copyLink.textContent = 'Link copied';
  } catch {
    els.copyLink.textContent = 'Copy failed';
  }
  setTimeout(() => { els.copyLink.textContent = 'Copy link'; }, 1600);
});

els.canvas.addEventListener('keydown', (e) => {
  if (!state.patch) return;
  if (e.key === ' ') {
    e.preventDefault();
    state.playing ? stopBlink() : startBlink();
  }
  if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  if (e.key === 'ArrowLeft')  { e.preventDefault(); step(-1); }
});

// ---------- start ----------

async function start() {
  renderPresets();
  applyFilters();
  try {
    state.patches = await loadJSON('data/patches.json');
  } catch {
    state.patches = [];
  }

  // Coordinates in the URL (?ra=133.795&dec=-7.245&fov=0.25) open straight to the viewer,
  // so other sites can link or embed a specific patch of sky.
  const q = new URLSearchParams(location.search);
  if (q.has('ra') && q.has('dec')) {
    els.ra.value = q.get('ra');
    els.dec.value = q.get('dec');
    if (q.has('fov') && [...els.fov.options].some(o => o.value === q.get('fov'))) els.fov.value = q.get('fov');
    const ra = parseRA(els.ra.value), dec = parseDec(els.dec.value);
    if (ra !== null && dec !== null) search(ra, dec, Number(els.fov.value), { updateUrl: false });
  }
}

start();
