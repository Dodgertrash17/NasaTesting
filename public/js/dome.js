// Sky Dome: stand in an open field and look around the SPHEREx sky.
//
//   dome.html                          open at the horizon
//   dome.html?poi=rdra                 fly to a point of interest from data/dome/poi.json
//   dome.html?ra=133.79&dec=-7.24&name=WISE+0855   fly to any coordinates (used by the Viewer)
//
// Drawn on a 2D canvas with a stereographic projection (wide views without stretching).
// Background stars and the Milky Way are illustrative; point-of-interest positions are real.
// The wavelength bar switches the whole sky between SPHEREx's 102 bands.

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const DET_COLORS = ['#7aa2ff', '#7cc4ff', '#7be0c8', '#c8e07b', '#ffc857', '#ff8f6b'];
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// Which spectral features to point out on each kind of spectrum (wavelengths in µm).
const FEATURES = {
  'y-dwarf': [[2.7, 'H₂O'], [3.3, 'CH₄']],
  't-dwarf': [[2.25, 'CH₄'], [3.3, 'CH₄']],
  'mira': [[1.9, 'H₂O'], [2.7, 'H₂O']],
  'm-dwarf': [[2.3, 'CO']],
  't-tauri': [[2.17, 'Brγ']],
  'nebula': [[1.88, 'Paα'], [3.29, 'PAH'], [4.05, 'Brα']],
  'starburst': [[3.29, 'PAH'], [4.05, 'Brα']],
  'protostar': [[3.05, 'H₂O ice'], [4.27, 'CO₂'], [4.67, 'CO']],
  'galactic-center': [[3.05, 'H₂O ice'], [4.27, 'CO₂ ice']],
  'galaxy': [[1.6, 'stellar bump']],
};

// ---------------------------------------------------------------- state

const S = {
  lat: 35 * D2R,          // observer latitude
  lst: 0,                 // local sidereal time (radians): turns the sky
  az: Math.PI, alt: 20 * D2R, fov: 100 * D2R,   // camera: facing south, a bit up
  band: 40, allBands: true,
  ground: true, labels: true, grid: false,
  pois: [], bands: [], layout: null,
  selected: null,         // a POI, or { custom: true, ra, dec, name }
  hover: null,
  flight: null,           // running fly-to animation
  blinkTimer: null,
  dirtyBg: true,
};

const $ = (s) => document.querySelector(s);
const dome = $('#dome');
const canvas = $('#dome-sky');
const ctx = canvas.getContext('2d');
const bg = document.createElement('canvas');      // low-res sky + ground, scaled up
const bgx = bg.getContext('2d');
let W = 0, H = 0, DPR = 1, F = 1;                // canvas size and projection scale
let CX = 0, CY = 0;                               // screen point the camera looks at (moves aside for the panel)

// ---------------------------------------------------------------- vector math

function eqVec(ra, dec) {   // degrees -> unit vector (equatorial)
  const a = ra * D2R, d = dec * D2R;
  return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Equatorial -> horizontal (x = east, y = north, z = up) for the current latitude and sidereal time.
let M = null;
function updateMatrix() {
  const st = Math.sin(S.lst), ct = Math.cos(S.lst), sp = Math.sin(S.lat), cp = Math.cos(S.lat);
  M = [[-st, ct, 0], [-sp * ct, -sp * st, cp], [cp * ct, cp * st, sp]];
}
const toHor = (v) => [dot(M[0], v), dot(M[1], v), dot(M[2], v)];
const toEq = (h) => [M[0][0] * h[0] + M[1][0] * h[1] + M[2][0] * h[2],
                     M[0][1] * h[0] + M[1][1] * h[1] + M[2][1] * h[2],
                     M[0][2] * h[0] + M[1][2] * h[1] + M[2][2] * h[2]];
const horAltAz = (h) => [Math.asin(clamp(h[2], -1, 1)), Math.atan2(h[0], h[1])];

// Camera basis in the horizontal frame.
let CF, CR, CU;
function updateCamera() {
  const ca = Math.cos(S.alt), sa = Math.sin(S.alt), cz = Math.cos(S.az), sz = Math.sin(S.az);
  CF = [ca * sz, ca * cz, sa];
  CR = [cz, -sz, 0];
  CU = [CR[1] * CF[2] - CR[2] * CF[1], CR[2] * CF[0] - CR[0] * CF[2], CR[0] * CF[1] - CR[1] * CF[0]];
  F = W / (4 * Math.tan(S.fov / 4));
  // keep the target in the part of the sky the info panel doesn't cover
  const open = !panel.hidden;
  const narrow = W < 700;
  CX = W / 2 - (open && !narrow ? Math.min(380, W * 0.35) / 2 : 0);
  CY = H / 2 - (open && narrow ? H * 0.22 : 0);
}

// Horizontal direction -> screen. Returns null when behind the viewer.
function project(h) {
  const z = dot(h, CF);
  if (z < -0.3) return null;
  const k = 2 * F / (1 + z);
  return [CX + k * dot(h, CR), CY - k * dot(h, CU)];
}
function unproject(px, py) {
  const u = (px - CX) / (2 * F), v = -(py - CY) / (2 * F), s = u * u + v * v;
  const x = 2 * u / (1 + s), y = 2 * v / (1 + s), z = (1 - s) / (1 + s);
  return [x * CR[0] + y * CU[0] + z * CF[0], x * CR[1] + y * CU[1] + z * CF[1], x * CR[2] + y * CU[2] + z * CF[2]];
}

// Treeline: horizon height (radians) at azimuth az.
function horizonAt(az) {
  let h = 0.5 + 0.6 * Math.sin(az * 3 + 1) * Math.sin(az * 7 + 2) + 0.4 * Math.sin(az * 13);
  for (const [c, w, ht] of TREES) {
    let d = Math.abs(((az - c + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (d < w) h += ht * Math.sqrt(1 - (d / w) ** 2) * (0.85 + 0.15 * Math.sin(az * 200));
  }
  return Math.max(0, h) * D2R;
}
const TREES = [[0.3, 0.05, 4], [0.38, 0.03, 3], [1.9, 0.08, 3.5], [2.05, 0.04, 5], [3.4, 0.06, 2.5],
               [4.4, 0.05, 4.5], [4.5, 0.035, 3], [5.6, 0.09, 3]].map(([c, w, h]) => [c, w, h]);

// ---------------------------------------------------------------- wavelength

function lambda() { return S.allBands ? null : S.bands[S.band].center_um; }

function bb(lam, T) {
  const x = 14388 / (lam * T);
  return x > 700 ? 0 : 1 / (lam ** 3 * (Math.exp(x) - 1));
}

function bandFactor(spectrum) {          // brightness of a POI in the chosen band (0..1)
  if (!spectrum) return 1;
  if (S.allBands) return spectrum.reduce((a, b) => a + b, 0) / spectrum.length / Math.max(...spectrum) * 1.4;
  return spectrum[S.band];
}

// ---------------------------------------------------------------- background stars (illustrative)

const NGP = eqVec(192.85948, 27.12825), GC = eqVec(266.4168, -29.0078), NEP = eqVec(270, 66.5607);
const STARS = (() => {
  let s = 12345;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const out = [];
  while (out.length < 12000) {
    const z = rand() * 2 - 1, t = rand() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    const v = [r * Math.cos(t), r * Math.sin(t), z];
    const b = Math.asin(dot(v, NGP));
    if (rand() > 0.3 + 0.7 * Math.exp(-(((b / 0.25)) ** 2))) continue;     // crowd toward the Milky Way
    // the first 3200 are naked-eye stars; the rest are faint ones that appear as you zoom in
    const mag = out.length < 3200 ? 6.6 - 5.6 * rand() ** 3.5 : 6.6 + 3 * rand() ** 0.5;
    const T = [3000, 3600, 4500, 5800, 7500, 11000, 20000][Math.floor(rand() ** 1.4 * 7)];
    out.push({ v, mag, T, f: 1, tw: rand() * 6.28 });
  }
  return out;
})();
const STAR_RGB = { 3000: '255,190,150', 3600: '255,210,170', 4500: '255,230,200', 5800: '255,248,235',
                   7500: '235,240,255', 11000: '205,220,255', 20000: '185,205,255' };

function updateStarBand() {
  const lam = lambda();
  const norm = {};
  for (const T of Object.keys(STAR_RGB)) norm[T] = Math.max(...S.bands.map(b => bb(b.center_um, +T)));
  for (const st of STARS) st.f = lam ? Math.pow(bb(lam, st.T) / norm[st.T], 0.6) : 1;
}

// ---------------------------------------------------------------- sky + ground (low-res, per pixel)

const BG_SCALE = 3;
function renderBackground() {
  const w = bg.width, h = bg.height;
  const img = bgx.createImageData(w, h), d = img.data;
  const lam = lambda();
  const ln = lam ? (lam - 0.75) / 4.25 : 0.5;          // 0 at 0.75 µm, 1 at 5 µm
  const mwGain = 0.75 + 0.5 * ln;                      // dust hides less at long wavelengths
  const zodiGain = lam ? 0.15 + 1.4 * Math.max(0, ln - 0.55) ** 1.5 * 3 : 0.35;   // zodiacal glow rises past ~3.5 µm
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const hv = unproject((i + 0.5) * BG_SCALE, (j + 0.5) * BG_SCALE);
      const [alt, az] = horAltAz(hv);
      const p = (j * w + i) * 4;
      if (S.ground && alt < horizonAt(az)) {
        // ground: dark field, a little lighter toward the horizon
        const g = clamp(1 + alt / 0.5, 0, 1);
        const n = Math.sin(az * 90 + alt * 300) * Math.sin(az * 37 - alt * 170);
        d[p] = 6 + 10 * g + n * 2; d[p + 1] = 13 + 20 * g + n * 3; d[p + 2] = 9 + 12 * g; d[p + 3] = 255;
        if (alt > horizonAt(az) - 0.012 && alt > 0.001) { d[p] = 3; d[p + 1] = 6; d[p + 2] = 5; }   // tree edge
        continue;
      }
      const e = toEq(hv);
      const b = Math.asin(clamp(dot(e, NGP), -1, 1));
      const gc = Math.acos(clamp(dot(e, GC), -1, 1));
      const mott = 0.75 + 0.25 * Math.sin(e[0] * 23 + e[1] * 9) * Math.sin(e[1] * 17 - e[2] * 29) +
                   0.15 * Math.sin(e[0] * 61 - e[2] * 47);
      const dust = 1 - 0.55 * Math.exp(-(((b / 0.03)) ** 2)) * (1 - ln);   // dark lane, fades in the infrared
      let mw = (0.55 * Math.exp(-(((b / 0.17)) ** 2)) + 0.9 * Math.exp(-(((gc / 0.45)) ** 2))) * mott * dust * mwGain;
      const beta = Math.asin(clamp(dot(e, NEP), -1, 1));
      const zodi = zodiGain * 0.35 * Math.exp(-(((beta / 0.45)) ** 2));
      const glow = Math.exp(-Math.max(alt, 0) / 0.18);              // brighter toward the horizon
      d[p]     = clamp(2 + 14 * glow + 70 * mw + 60 * zodi, 0, 255);
      d[p + 1] = clamp(4 + 22 * glow + 72 * mw + 45 * zodi, 0, 255);
      d[p + 2] = clamp(10 + 40 * glow + 90 * mw + 30 * zodi, 0, 255);
      d[p + 3] = 255;
    }
  }
  bgx.putImageData(img, 0, 0);
  S.dirtyBg = false;
}

// ---------------------------------------------------------------- drawing

const poiScreen = [];   // [{poi, x, y, r}] for clicking

function typeColor(t) {
  t = t.toLowerCase();
  if (t.includes('dwarf')) return '#ff8f6b';
  if (t.includes('nebula') || t.includes('cloud') || t.includes('remnant')) return '#ff7ac8';
  if (t.includes('galax') || t.includes('field') || t.includes('center')) return '#b49cff';
  if (t.includes('variable') || t.includes('young')) return '#7be0c8';
  return '#ffd27a';
}

function draw(now) {
  updateCamera();
  if (S.dirtyBg) renderBackground();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(bg, 0, 0, W, H);

  // stars
  const zoom = clamp(Math.sqrt((60 * D2R) / S.fov), 0.8, 3);
  const limit = clamp(6.6 + 2.2 * Math.log2((90 * D2R) / S.fov), 6.6, 9.6);   // zooming in reveals fainter stars
  for (const st of STARS) {
    if (st.mag > limit) continue;
    const h = toHor(st.v);
    const alt = Math.asin(h[2]);
    if (S.ground && alt < horizonAt(Math.atan2(h[0], h[1]))) continue;
    const p = project(h);
    if (!p || p[0] < -5 || p[1] < -5 || p[0] > W + 5 || p[1] > H + 5) continue;
    const ext = clamp((alt * R2D + 2) / 12, 0.15, 1);                    // dimmer near the horizon
    const a = clamp((limit + 0.4 - st.mag) / 5.5, 0.12, 1) * st.f * ext * (0.9 + 0.1 * Math.sin(now / 700 + st.tw));
    if (a < 0.03) continue;
    const r = Math.max(0.6, (limit + 0.2 - st.mag) * 0.42 * zoom * (0.6 + 0.4 * st.f));
    ctx.fillStyle = `rgba(${STAR_RGB[st.T]},${a})`;
    ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 6.283); ctx.fill();
  }

  if (S.grid) drawGrid();
  drawCompass();
  drawPois(now);
  if (S.selected?.custom) drawCustomTarget(now);
  updateStatus();
}

function drawGrid() {
  ctx.strokeStyle = 'rgba(124,196,255,0.18)';
  ctx.lineWidth = 1;
  for (const altDeg of [15, 30, 45, 60, 75]) {
    ctx.beginPath();
    let pen = false;
    for (let a = 0; a <= 360; a += 3) {
      const h = [Math.cos(altDeg * D2R) * Math.sin(a * D2R), Math.cos(altDeg * D2R) * Math.cos(a * D2R), Math.sin(altDeg * D2R)];
      const p = project(h);
      if (!p) { pen = false; continue; }
      pen ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); pen = true;
    }
    ctx.stroke();
  }
  for (let a = 0; a < 360; a += 45) {
    ctx.beginPath();
    let pen = false;
    for (let altDeg = 0; altDeg <= 88; altDeg += 4) {
      const h = [Math.cos(altDeg * D2R) * Math.sin(a * D2R), Math.cos(altDeg * D2R) * Math.cos(a * D2R), Math.sin(altDeg * D2R)];
      const p = project(h);
      if (!p) { pen = false; continue; }
      pen ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); pen = true;
    }
    ctx.stroke();
  }
}

function drawCompass() {
  ctx.font = '700 14px "Atkinson Hyperlegible Next", sans-serif';
  ctx.textAlign = 'center';
  for (let i = 0; i < 8; i++) {
    const az = i * 45 * D2R;
    const altL = horizonAt(az) + 1.5 * D2R;
    const p = project([Math.cos(altL) * Math.sin(az), Math.cos(altL) * Math.cos(az), Math.sin(altL)]);
    if (!p || p[0] < 0 || p[0] > W || p[1] < 0 || p[1] > H) continue;
    ctx.fillStyle = i % 2 ? 'rgba(154,166,191,0.7)' : 'rgba(255,200,87,0.95)';
    ctx.fillText(COMPASS[i], p[0], p[1]);
  }
}

function poiAltOk(h) {
  return !S.ground || Math.asin(h[2]) > horizonAt(Math.atan2(h[0], h[1])) - 0.5 * D2R;
}

function drawPois(now) {
  poiScreen.length = 0;
  const zoom = clamp(Math.sqrt((60 * D2R) / S.fov), 0.8, 2.6);
  ctx.textAlign = 'left';
  for (const poi of S.pois) {
    const h = toHor(poi.vec);
    if (!poiAltOk(h)) continue;
    const p = project(h);
    if (!p || p[0] < -40 || p[1] < -40 || p[0] > W + 40 || p[1] > H + 40) continue;
    const f = clamp(bandFactor(poi.spectrum), 0, 1);
    const base = (3 + poi.size * 1.8) * zoom;
    const r = base * (0.35 + 0.65 * Math.sqrt(f));
    const col = typeColor(poi.type);
    const sel = S.selected === poi, hov = S.hover === poi;
    const pulse = 1 + 0.15 * Math.sin(now / 350);

    const g = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], r * 3.2);
    g.addColorStop(0, col + 'aa'); g.addColorStop(1, col + '00');
    ctx.globalAlpha = 0.35 + 0.65 * f;
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(p[0], p[1], r * 3.2, 0, 6.283); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(p[0], p[1], Math.max(1.5, r * 0.45), 0, 6.283); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = col;
    ctx.lineWidth = sel ? 2.5 : 1.5;
    ctx.beginPath(); ctx.arc(p[0], p[1], (r + 5) * (sel ? pulse : 1), 0, 6.283); ctx.stroke();
    if (sel || hov) {
      ctx.strokeStyle = '#ffc857';
      ctx.beginPath(); ctx.arc(p[0], p[1], r + 11, 0, 6.283); ctx.stroke();
    }
    poiScreen.push({ poi, x: p[0], y: p[1], r: r + 10 });

    if (S.labels && (sel || hov || poi.size >= 4 || S.fov < 70 * D2R)) {
      ctx.font = `${sel ? 700 : 400} 13px "Atkinson Hyperlegible Next", sans-serif`;
      ctx.fillStyle = '#000a';
      const tx = p[0] + r + 9, ty = p[1] + 4;
      ctx.fillText(poi.name, tx + 1, ty + 1);
      ctx.fillStyle = sel ? '#ffc857' : '#e8ecf6';
      ctx.fillText(poi.name, tx, ty);
    }
  }
}

function drawCustomTarget(now) {
  const t = S.selected;
  const h = toHor(t.vec);
  const p = project(h);
  if (!p) return;
  const r = 14 + 2 * Math.sin(now / 300);
  ctx.strokeStyle = '#ffc857'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 6.283); ctx.stroke();
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    ctx.beginPath(); ctx.moveTo(p[0] + dx * (r + 4), p[1] + dy * (r + 4)); ctx.lineTo(p[0] + dx * (r + 14), p[1] + dy * (r + 14)); ctx.stroke();
  }
  ctx.font = '700 13px "Atkinson Hyperlegible Next", sans-serif';
  ctx.fillStyle = '#ffc857'; ctx.textAlign = 'left';
  ctx.fillText(t.name, p[0] + r + 18, p[1] + 4);
}

function updateStatus() {
  const facing = COMPASS[Math.round((((S.az * R2D) % 360) + 360) % 360 / 45) % 8];
  $('#dome-status').innerHTML =
    `<strong>Field at ${Math.abs(Math.round(S.lat * R2D))}°${S.lat >= 0 ? 'N' : 'S'}</strong><br>` +
    `Facing ${facing}, ${Math.round(S.alt * R2D)}° up · ${Math.round(S.fov * R2D)}° view`;
}

// ---------------------------------------------------------------- loop

let lastKey = '';
function frame(now) {
  if (S.flight) stepFlight(now);
  const key = [S.az, S.alt, S.fov, S.lst, S.lat, S.ground, S.allBands, S.band, W, H, panel.hidden].join();
  if (key !== lastKey) { S.dirtyBg = true; lastKey = key; }
  draw(now);
  requestAnimationFrame(frame);
}

function resize() {
  DPR = Math.min(devicePixelRatio || 1, 2);
  W = dome.clientWidth; H = dome.clientHeight;
  canvas.width = W * DPR; canvas.height = H * DPR;
  bg.width = Math.ceil(W / BG_SCALE); bg.height = Math.ceil(H / BG_SCALE);
  S.dirtyBg = true;
}

// ---------------------------------------------------------------- flying

// Pick where to stand and what time it is, so the target is high in the sky.
function skyFor(ra, dec) {
  let lat = S.lat * R2D;
  if (90 - Math.abs(lat - dec) < 30) lat = clamp(dec + (dec >= 0 ? -30 : 30), -60, 60);   // move north or south
  return { lat: lat * D2R, lst: ra * D2R };      // sidereal time = RA puts it due south/north, highest point
}

function wrapPi(a) { return ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; }

function flyTo(target, { fromGround = false } = {}) {
  const sky = skyFor(target.ra, target.dec);
  const vec = eqVec(target.ra, target.dec);
  if (fromGround) {               // stand in the field first, then look up
    S.lat = sky.lat; S.lst = sky.lst; updateMatrix();
    const [, az] = horAltAz(toHor(vec));
    S.az = az + 150 * D2R; S.alt = 3 * D2R; S.fov = 100 * D2R;
  }
  const endFov = target.fov ? clamp(target.fov * 30, 6, 30) * D2R : 14 * D2R;
  S.flight = { t0: performance.now(), dur: REDUCED ? 1 : (fromGround ? 4200 : 3000), vec,
               from: { az: S.az, alt: S.alt, fov: S.fov, lat: S.lat, lst: S.lst },
               to: { lat: sky.lat, lst: S.lst + wrapPi(sky.lst - S.lst), fov: endFov }, fromGround };
}

function stepFlight(now) {
  const fl = S.flight;
  const t = clamp((now - fl.t0) / fl.dur, 0, 1);
  if (fl.horizon) {                                         // "Horizon" button: tilt back down, zoom out
    const e = ease(t);
    S.alt = fl.from.alt + (15 * D2R - fl.from.alt) * e;
    S.fov = fl.from.fov + (100 * D2R - fl.from.fov) * e;
    if (t >= 1) S.flight = null;
    return;
  }
  const turn = ease(clamp(t / 0.7, 0, 1));                  // first 70%: turn and look up
  const zoomT = ease(clamp((t - 0.45) / 0.55, 0, 1));       // last 55%: zoom in
  S.lat = fl.from.lat + (fl.to.lat - fl.from.lat) * turn;
  S.lst = fl.from.lst + (fl.to.lst - fl.from.lst) * turn;
  updateMatrix();
  const [tAlt, tAz] = horAltAz(toHor(fl.vec));
  S.az = fl.from.az + wrapPi(tAz - fl.from.az) * turn;
  S.alt = fl.from.alt + (tAlt - fl.from.alt) * turn;
  const wide = Math.max(fl.from.fov, 80 * D2R);
  S.fov = t < 0.45 ? fl.from.fov + (wide - fl.from.fov) * ease(t / 0.45) : wide + (fl.to.fov - wide) * zoomT;
  if (t >= 1) S.flight = null;
}

// ---------------------------------------------------------------- point-of-interest panel

const panel = $('#poi-panel');
let cubeImg = null, stackedTile = null, bandCanvas = null;

function selectPoi(poi, { fly = true } = {}) {
  S.selected = poi;
  if (fly) flyTo(poi);
  history.replaceState(null, '', `?poi=${poi.id}`);
  $('#fly-to').value = poi.id;
  renderPanel();
}

function selectCustom(ra, dec, name, fov) {
  S.selected = { custom: true, ra, dec, name: name || `${formatRA(ra)} ${formatDec(dec)}`, vec: eqVec(ra, dec), fov };
  renderPanel();
}

function renderPanel() {
  const t = S.selected;
  if (!t) { panel.hidden = true; return; }
  panel.hidden = false;
  if (t.custom) {
    panel.innerHTML = `
      <header><div><span class="pill pill-brand">Your target</span><h2 id="poi-name"></h2></div>
        <button class="close" type="button" aria-label="Close">✕</button></header>
      <p class="mono small muted">${formatRA(t.ra)} · ${formatDec(t.dec)}</p>
      <p class="blurb">No 102-band data for this exact spot yet. When SPHEREx spectra are added for it, they'll show here.</p>
      <div class="poi-actions">
        <a class="btn primary" href="${viewerUrl({ ra: t.ra, dec: t.dec, fov: t.fov || 0.25, name: t.name })}">Open in Viewer</a>
        <button type="button" data-copy>Copy link</button>
      </div>`;
    panel.querySelector('#poi-name').textContent = t.name;
    wirePanelCommon();
    return;
  }
  panel.innerHTML = `
    <header><div><span class="pill" style="color:${typeColor(t.type)};border-color:${typeColor(t.type)}66">${t.type}</span>
      <h2 id="poi-name"></h2></div>
      <button class="close" type="button" aria-label="Close">✕</button></header>
    <p class="mono small muted">${formatRA(t.ra)} · ${formatDec(t.dec)}</p>
    <p class="blurb"></p>
    <h3>Seen in 102 infrared bands</h3>
    <div class="band-view"><canvas id="band-canvas" width="240" height="240"></canvas>
      <span class="badge badge-warn">Simulated</span>
      <span class="badge badge-date mono" id="band-badge"></span></div>
    <div class="band-caption"><span id="band-cap"></span>
      <label class="check small"><input type="checkbox" id="false-color" checked> False color</label></div>
    <h3>All bands at once <span class="muted" style="text-transform:none;letter-spacing:0">(click one)</span></h3>
    <div class="band-grid" id="band-grid"><img alt="Grid of 102 small images, one per band" src="data/${t.cube}"><div class="hl" id="band-hl"></div></div>
    <h3>Spectrum <span class="muted" style="text-transform:none;letter-spacing:0">(click to pick a band)</span></h3>
    <canvas class="spec-chart" id="spec-chart"></canvas>
    <p class="muted small" style="margin:6px 0 0">Brightness at each wavelength. Dips and bumps reveal molecules like water, methane and ices.</p>
    <div class="poi-actions">
      ${t.patch ? `<a class="btn primary" href="${viewerUrl({ ra: t.ra, dec: t.dec, fov: 0.25, name: t.name })}">Open in Viewer</a>` : ''}
      <button type="button" data-copy>Copy link</button>
    </div>`;
  panel.querySelector('#poi-name').textContent = t.name;
  panel.querySelector('.blurb').textContent = t.blurb;
  wirePanelCommon();

  bandCanvas = panel.querySelector('#band-canvas');
  panel.querySelector('#false-color').addEventListener('change', drawBandTile);
  const grid = panel.querySelector('#band-grid');
  grid.addEventListener('click', (e) => {
    const r = grid.getBoundingClientRect();
    const col = clamp(Math.floor((e.clientX - r.left) / r.width * 17), 0, 16);
    const row = clamp(Math.floor((e.clientY - r.top) / r.height * 6), 0, 5);
    setBand(row * 17 + col);
  });
  const chart = panel.querySelector('#spec-chart');
  chart.addEventListener('click', (e) => {
    const r = chart.getBoundingClientRect();
    const lam = 0.7 + (e.clientX - r.left - 30) / (r.width - 40) * 4.4;
    let best = 0;
    S.bands.forEach((b, i) => { if (Math.abs(b.center_um - lam) < Math.abs(S.bands[best].center_um - lam)) best = i; });
    setBand(best);
  });

  cubeImg = null; stackedTile = null;
  loadImage(`data/${t.cube}`).then(img => {
    if (S.selected !== t) return;
    cubeImg = img;
    stackedTile = makeStacked(img);
    updatePanelBand();
  });
  updatePanelBand();
}

function wirePanelCommon() {
  panel.querySelector('.close').addEventListener('click', () => {
    S.selected = null; panel.hidden = true; history.replaceState(null, '', 'dome.html'); $('#fly-to').value = '';
  });
  panel.querySelector('[data-copy]').addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText(location.href); e.target.textContent = 'Link copied'; }
    catch { e.target.textContent = 'Copy failed'; }
    setTimeout(() => { e.target.textContent = 'Copy link'; }, 1500);
  });
}

// Average all 102 tiles: what the object looks like with every band added together.
function makeStacked(img) {
  const T = S.layout.tile_px;
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const cx = c.getContext('2d'); cx.drawImage(img, 0, 0);
  const all = cx.getImageData(0, 0, c.width, c.height).data;
  const out = new ImageData(T, T);
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
    let s = 0;
    for (let r = 0; r < 6; r++) for (let k = 0; k < 17; k++) s += all[((r * T + y) * c.width + k * T + x) * 4];
    const v = Math.min(255, s / 102 * 1.3);
    const p = (y * T + x) * 4; out.data[p] = out.data[p + 1] = out.data[p + 2] = v; out.data[p + 3] = 255;
  }
  const t = document.createElement('canvas'); t.width = T; t.height = T;
  t.getContext('2d').putImageData(out, 0, 0);
  return t;
}

// False color: blue for the shortest SPHEREx wavelengths, red for the longest.
function bandRGB(i) {
  const x = i / 101;
  const stops = [[0, [120, 150, 255]], [0.35, [120, 230, 220]], [0.65, [255, 220, 110]], [1, [255, 110, 90]]];
  for (let k = 1; k < stops.length; k++) if (x <= stops[k][0]) {
    const [x0, a] = stops[k - 1], [x1, b] = stops[k], u = (x - x0) / (x1 - x0);
    return a.map((v, j) => Math.round(v + (b[j] - v) * u));
  }
  return stops.at(-1)[1];
}

function drawBandTile() {
  if (!bandCanvas) return;
  const c = bandCanvas.getContext('2d');
  c.imageSmoothingEnabled = false;
  c.fillStyle = '#000'; c.fillRect(0, 0, 240, 240);
  if (!cubeImg) return;
  const T = S.layout.tile_px;
  if (S.allBands) c.drawImage(stackedTile, 0, 0, 240, 240);
  else {
    const b = S.bands[S.band];
    c.drawImage(cubeImg, b.channel * T, (b.detector - 1) * T, T, T, 0, 0, 240, 240);
  }
  if (panel.querySelector('#false-color')?.checked && !S.allBands) {
    c.globalCompositeOperation = 'multiply';
    c.fillStyle = `rgb(${bandRGB(S.band).join()})`;
    c.fillRect(0, 0, 240, 240);
    c.globalCompositeOperation = 'source-over';
  }
}

function drawSpectrum() {
  const chart = panel.querySelector('#spec-chart');
  const t = S.selected;
  if (!chart || !t?.spectrum) return;
  const r = chart.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  chart.width = r.width * dpr; chart.height = r.height * dpr;
  const c = chart.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = r.width, h = r.height, L = 30, B = 22, Tp = 18;
  const X = (lam) => L + (lam - 0.7) / 4.4 * (w - L - 10);
  const Y = (v) => h - B - v * (h - B - Tp);
  c.strokeStyle = '#33405f'; c.fillStyle = '#9aa6bf'; c.font = '11px "Atkinson Hyperlegible Mono", monospace'; c.textAlign = 'center';
  for (let um = 1; um <= 5; um++) {
    c.beginPath(); c.moveTo(X(um), h - B); c.lineTo(X(um), h - B + 4); c.stroke();
    c.fillText(`${um} µm`, X(um), h - 6);
  }
  c.beginPath(); c.moveTo(L, h - B); c.lineTo(w - 8, h - B); c.stroke();
  (FEATURES[t.spectrum_model] || []).forEach(([lam, name], i, all) => {
    const crowded = i > 0 && X(lam) - X(all[i - 1][0]) < 40;      // drop the label lower if it would overlap
    c.strokeStyle = '#ffffff22'; c.setLineDash([3, 3]);
    c.beginPath(); c.moveTo(X(lam), Tp - 4); c.lineTo(X(lam), h - B); c.stroke(); c.setLineDash([]);
    c.fillStyle = '#c9d2e6'; c.fillText(name, X(lam), crowded ? 24 : 11);
  });
  t.spectrum.forEach((v, i) => {
    const b = S.bands[i];
    c.fillStyle = DET_COLORS[b.detector - 1];
    c.beginPath(); c.arc(X(b.center_um), Y(v), 2.2, 0, 6.283); c.fill();
  });
  if (!S.allBands) {
    const b = S.bands[S.band];
    c.strokeStyle = '#ffc857'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(X(b.center_um), Tp - 2); c.lineTo(X(b.center_um), h - B); c.stroke();
    c.fillStyle = '#ffc857'; c.beginPath(); c.arc(X(b.center_um), Y(t.spectrum[S.band]), 4, 0, 6.283); c.fill();
  }
}

function updatePanelBand() {
  const t = S.selected;
  if (!t || t.custom || panel.hidden) return;
  const b = S.bands[S.band];
  const hl = panel.querySelector('#band-hl');
  hl.hidden = S.allBands;
  hl.style.left = `${b.channel / 17 * 100}%`; hl.style.top = `${(b.detector - 1) / 6 * 100}%`;
  hl.style.width = `${100 / 17}%`; hl.style.height = `${100 / 6}%`;
  panel.querySelector('#band-badge').textContent = S.allBands ? 'All 102 bands' : `${b.center_um.toFixed(2)} µm`;
  panel.querySelector('#band-cap').textContent = S.allBands
    ? 'All bands added together'
    : `Band ${S.band + 1} of 102 · detector ${b.detector} · ${Math.round(t.spectrum[S.band] * 100)}% bright`;
  drawBandTile();
  drawSpectrum();
}

// ---------------------------------------------------------------- wavelength bar

function setBand(i, { keepBlink = false } = {}) {
  if (!keepBlink) stopBandBlink();
  S.band = clamp(i, 0, 101);
  S.allBands = false;
  syncWave();
}

function syncWave() {
  const b = S.bands[S.band];
  $('#band').value = S.band;
  $('#all-bands').setAttribute('aria-pressed', String(S.allBands));
  $('#wave-bar').classList.toggle('all-bands', S.allBands);
  $('#wave-read').textContent = S.allBands
    ? 'All 102 bands · 0.75–5.0 µm'
    : `${b.center_um.toFixed(2)} µm · band ${S.band + 1}/102 · detector ${b.detector}`;
  updateStarBand();
  updatePanelBand();
  S.dirtyBg = true;
}

function stopBandBlink() {
  clearInterval(S.blinkTimer); S.blinkTimer = null;
  $('#band-blink').setAttribute('aria-pressed', 'false');
  $('#band-blink').textContent = '▶ Sweep bands';
}

$('#band').addEventListener('input', (e) => setBand(+e.target.value));
$('#all-bands').addEventListener('click', () => { stopBandBlink(); S.allBands = !S.allBands; syncWave(); });
$('#band-blink').addEventListener('click', () => {
  if (S.blinkTimer) return stopBandBlink();
  if (S.allBands) setBand(0);
  $('#band-blink').setAttribute('aria-pressed', 'true');
  $('#band-blink').textContent = '❚❚ Pause';
  S.blinkTimer = setInterval(() => setBand((S.band + 1) % 102, { keepBlink: true }), 160);
});

// ---------------------------------------------------------------- input: drag, zoom, click, keys

const pointers = new Map();
let drag = null, pinch = null;

function hitPoi(x, y) {
  let best = null, bd = Infinity;
  for (const s of poiScreen) {
    const d = Math.hypot(s.x - x, s.y - y);
    if (d < s.r && d < bd) { best = s.poi; bd = d; }
  }
  return best;
}

function look(dx, dy) {
  S.flight = null;
  const k = 1 / F;
  S.az -= dx * k / Math.max(Math.cos(S.alt), 0.3);
  S.alt = clamp(S.alt + dy * k, (S.ground ? -12 : -89) * D2R, 89.5 * D2R);
}
function zoomBy(f) { S.flight = null; S.fov = clamp(S.fov * f, 4 * D2R, 140 * D2R); }

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
  if (pointers.size === 1) drag = { x: e.offsetX, y: e.offsetY, moved: 0 };
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), fov: S.fov };
  }
  hideHint();
});
canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) {
    S.hover = hitPoi(e.offsetX, e.offsetY);
    dome.classList.toggle('over-poi', !!S.hover);
    return;
  }
  const prev = pointers.get(e.pointerId);
  pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    S.flight = null;
    S.fov = clamp(pinch.fov * pinch.d / Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1])), 4 * D2R, 140 * D2R);
    return;
  }
  if (drag) {
    const dx = e.offsetX - prev[0], dy = e.offsetY - prev[1];
    drag.moved += Math.abs(dx) + Math.abs(dy);
    if (drag.moved > 4) { dome.classList.add('dragging'); look(dx, dy); }
  }
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (drag && pointers.size === 0) {
    if (drag.moved <= 4) {
      const poi = hitPoi(e.offsetX, e.offsetY);
      if (poi) selectPoi(poi);
    }
    drag = null;
    dome.classList.remove('dragging');
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', (e) => { e.preventDefault(); hideHint(); zoomBy(Math.exp(e.deltaY * 0.0012)); }, { passive: false });
canvas.addEventListener('keydown', (e) => {
  const step = 40;
  const k = { ArrowLeft: () => look(step, 0), ArrowRight: () => look(-step, 0), ArrowUp: () => look(0, step),
              ArrowDown: () => look(0, -step), '+': () => zoomBy(0.85), '=': () => zoomBy(0.85), '-': () => zoomBy(1.18) }[e.key];
  if (k) { e.preventDefault(); k(); hideHint(); }
});

$('#zoom-in').addEventListener('click', () => zoomBy(0.7));
$('#zoom-out').addEventListener('click', () => zoomBy(1.4));
$('#reset-view').addEventListener('click', () => {
  S.flight = { t0: performance.now(), dur: REDUCED ? 1 : 1500, vec: null,
               from: { az: S.az, alt: S.alt, fov: S.fov }, horizon: true };
});
$('#show-ground').addEventListener('change', (e) => { S.ground = e.target.checked; S.dirtyBg = true; });
$('#show-labels').addEventListener('change', (e) => { S.labels = e.target.checked; });
$('#show-grid').addEventListener('change', (e) => { S.grid = e.target.checked; });
$('#fly-to').addEventListener('change', (e) => {
  const poi = S.pois.find(p => p.id === e.target.value);
  if (poi) selectPoi(poi);
});

let hintTimer;
function hideHint() { $('#dome-hint').classList.add('gone'); clearTimeout(hintTimer); }

// Toolbar fades after 2.5 s without mouse movement, and comes back on movement.
let idleTimer;
function wake() {
  dome.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => dome.classList.add('idle'), 2500);
}
for (const ev of ['mousemove', 'keydown', 'touchstart', 'focusin']) dome.addEventListener(ev, wake);

// ---------------------------------------------------------------- start

(async function start() {
  resize();
  addEventListener('resize', resize);
  wake();
  hintTimer = setTimeout(hideHint, 6000);

  // Sidereal time for "now" at longitude 0, so the opening sky changes through the day.
  const jd = Date.now() / 86400000 + 2440587.5;
  S.lst = ((280.46061837 + 360.98564736629 * (jd - 2451545)) % 360) * D2R;
  updateMatrix();

  try {
    const [poiData, bandData] = await Promise.all([loadJSON('data/dome/poi.json'), loadJSON('data/dome/bands.json')]);
    S.pois = poiData.pois.map(p => ({ ...p, vec: eqVec(p.ra, p.dec) }));
    S.layout = poiData.cube_layout;
    S.bands = bandData.bands;
  } catch (err) {
    console.error(err);
    S.bands = Array.from({ length: 102 }, (_, i) => ({ index: i, detector: Math.floor(i / 17) + 1, channel: i % 17,
      center_um: 0.75 * (5 / 0.75) ** ((i + 0.5) / 102) }));
  }

  $('#det-strip').innerHTML = DET_COLORS.map((c, i) => {
    const lo = S.bands[i * 17].center_um, hi = S.bands[i * 17 + 16].center_um;
    return `<span style="background:${c}" title="Detector ${i + 1}: ${lo.toFixed(2)}–${hi.toFixed(2)} µm">${i + 1}</span>`;
  }).join('');
  for (const p of [...S.pois].sort((a, b) => a.name.localeCompare(b.name))) {
    $('#fly-to').insertAdjacentHTML('beforeend', `<option value="${p.id}"></option>`);
    $('#fly-to').lastElementChild.textContent = p.name;
  }
  syncWave();
  requestAnimationFrame(frame);

  // Arriving from a link: start on the ground, then turn and zoom to the target.
  const q = new URLSearchParams(location.search);
  const byId = S.pois.find(p => p.id === q.get('poi'));
  const ra = parseRA(q.get('ra') ?? ''), dec = parseDec(q.get('dec') ?? '');
  if (byId) {
    S.selected = byId; renderPanel(); $('#fly-to').value = byId.id;
    flyTo(byId, { fromGround: true });
  } else if (ra !== null && dec !== null) {
    const near = S.pois.find(p => separation(ra, dec, p.ra, p.dec) < 0.5);
    if (near) { S.selected = near; renderPanel(); $('#fly-to').value = near.id; history.replaceState(null, '', `?poi=${near.id}`); }
    else selectCustom(ra, dec, q.get('name'), Number(q.get('fov')) || 0.25);
    flyTo({ ra, dec }, { fromGround: true });
  }
})();
