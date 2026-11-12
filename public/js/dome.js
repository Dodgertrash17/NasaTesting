// Sky Dome: float inside the sky and look around the SPHEREx sky in every direction (full 360°).
//
//   dome.html                                     open on a wide view of Orion
//   dome.html?poi=rdra                            fly to a point of interest from data/dome/poi.json
//   dome.html?ra=133.79&dec=-7.24&name=WISE+0855  fly to any coordinates (used by the Viewer)
//   extra:  &band=40  &date=2026-03-14  &show=galaxy,white-dwarf
//   testing: &stress=20000 (add fake points)  &debug (frame times)  &cpu (force the slow fallback)
//
// Speed: the sky, Milky Way and ~30k stars are drawn by the graphics card (WebGL) and only
// when the view changes. Points of interest are drawn on a 2D layer on top, using a spatial index so
// only the ones in view are touched, with a cap on dots and labels when there are many.

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const Q = new URLSearchParams(location.search);
const DEBUG = Q.has('debug');
const DET_COLORS = ['#7aa2ff', '#7cc4ff', '#7be0c8', '#c8e07b', '#ffc857', '#ff8f6b'];
const MAX_DOTS = 1500, MAX_LABELS = 45;

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

const FALLBACK_CATS = { star: { label: 'Stars', color: '#ffd27a', shape: 'circle' } };

// ---------------------------------------------------------------- state

const S = {
  // The view frame is fixed to the sky: celestial north is up, and turning left/right moves along Right Ascension.
  lat: 90 * D2R, lst: 0,
  az: Math.PI - 85 * D2R, alt: 0, fov: 100 * D2R, // camera (starts on Orion)
  band: 40, allBands: true,
  dates: [], dateIdx: null,                       // null = each object's latest image
  labels: true, grid: false,
  pois: [], cats: FALLBACK_CATS, bands: [], layout: null,
  shown: new Set(), search: '', onlyPatch: false,
  selected: null, hover: null, flight: null,
  bandTimer: null, dateTimer: null,
  dirtySky: true, dirtyOverlay: true,
};

const $ = (s) => document.querySelector(s);
const dome = $('#dome');
const overlay = $('#dome-sky');
const octx = overlay.getContext('2d');
const panel = $('#poi-panel');
const filterPanel = $('#filter-panel');
let W = 0, H = 0, DPR = 1, F = 1, CX = 0, CY = 0;

// ---------------------------------------------------------------- vector math

function eqVec(ra, dec) {
  const a = ra * D2R, d = dec * D2R;
  return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Equatorial -> view frame. With lat = 90° and lst = 0 this is just the sky's own frame (z = celestial north).
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

let CF, CR, CU;
function updateCamera() {
  const ca = Math.cos(S.alt), sa = Math.sin(S.alt), cz = Math.cos(S.az), sz = Math.sin(S.az);
  CF = [ca * sz, ca * cz, sa];
  CR = [cz, -sz, 0];
  CU = [CR[1] * CF[2] - CR[2] * CF[1], CR[2] * CF[0] - CR[0] * CF[2], CR[0] * CF[1] - CR[1] * CF[0]];
  F = W / (4 * Math.tan(S.fov / 4));
  // keep the target in the part of the sky the side panels don't cover
  const narrow = W < 700;
  const right = !panel.hidden && !narrow ? Math.min(380, W * 0.35) : 0;
  const left = !filterPanel.hidden && !narrow ? Math.min(330, W * 0.3) : 0;
  CX = W / 2 + (left - right) / 2;
  CY = H / 2 - (!panel.hidden && narrow ? H * 0.22 : 0);
}

// Stereographic projection: horizontal direction -> screen point (CSS px), null if behind you.
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
function viewRadius() {   // angle from view center to the farthest screen corner
  const r = Math.hypot(Math.max(CX, W - CX), Math.max(CY, H - CY));
  return 2 * Math.atan(r / (2 * F));
}

// ---------------------------------------------------------------- wavelength + date helpers

function lambda() { return S.allBands ? null : S.bands[S.band].center_um; }

function bb(lam, T) {
  const x = 14388 / (lam * T);
  return x > 700 ? 0 : 1 / (lam ** 3 * (Math.exp(x) - 1));
}

function bandFactor(poi) {
  const sp = poi.spectrum;
  if (!sp) return 0.8;
  if (S.allBands) return poi._mean;
  return sp[S.band];
}

function currentMjd() { return S.dateIdx === null ? Infinity : S.dates[S.dateIdx]; }

// The object's image for the chosen date: the latest one taken on or before it.
function epochOf(poi) {
  const eps = poi.epochs;
  if (!eps?.length) return null;
  const t = currentMjd();
  let i = -1;
  for (let k = 0; k < eps.length; k++) if (eps[k].mjd <= t + 0.5) i = k;
  return i < 0 ? { i: 0, ep: eps[0], before: true } : { i, ep: eps[i], before: false };
}

function iso(mjd) { return mjdToDate(mjd); }

// ---------------------------------------------------------------- background stars (illustrative)

const NGP = eqVec(192.85948, 27.12825), GC = eqVec(266.4168, -29.0078), NEP = eqVec(270, 66.5607);
const TEMPS = [3000, 3600, 4500, 5800, 7500, 11000, 20000];
const TEMP_RGB = [[255, 190, 150], [255, 210, 170], [255, 230, 200], [255, 248, 235], [235, 240, 255], [205, 220, 255], [185, 205, 255]];
const BAND_F = new Float32Array(7).fill(1);        // brightness of each star color in the chosen band

function makeStars(n) {
  let s = 12345;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const out = new Float32Array(n * 5);
  let k = 0;
  while (k < n) {
    const z = rand() * 2 - 1, t = rand() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    const v = [r * Math.cos(t), r * Math.sin(t), z];
    const b = Math.asin(dot(v, NGP));
    if (rand() > 0.3 + 0.7 * Math.exp(-((b / 0.25) ** 2))) continue;   // crowd toward the Milky Way
    const mag = k < 3200 ? 6.6 - 5.6 * rand() ** 3.5 : 6.6 + 3 * rand() ** 0.5;
    out.set([v[0], v[1], v[2], mag, Math.floor(rand() ** 1.4 * 7)], k * 5);
    k++;
  }
  return out;
}

function updateBandFactors() {
  const lam = lambda();
  TEMPS.forEach((T, i) => {
    BAND_F[i] = lam ? Math.pow(bb(lam, T) / Math.max(...S.bands.map(b => bb(b.center_um, T))), 0.6) : 1;
  });
}

function waveParams() {
  const lam = lambda();
  const ln = lam ? (lam - 0.75) / 4.25 : 0.5;
  return [ln, 0.75 + 0.5 * ln, lam ? 0.15 + 1.4 * Math.max(0, ln - 0.55) ** 1.5 * 3 : 0.35];
}

const limitMag = () => clamp(6.6 + 2.2 * Math.log2((90 * D2R) / S.fov), 6.6, 9.6);
const zoomBoost = () => clamp(Math.sqrt((60 * D2R) / S.fov), 0.8, 3);

// ---------------------------------------------------------------- GPU sky (WebGL)

const GLSL_COMMON = `
uniform mat3 uM; uniform vec3 uR; uniform vec3 uU; uniform vec3 uFw;
uniform vec2 uC; uniform float uF;`;

const SKY_VS = `attribute vec2 aP; void main() { gl_Position = vec4(aP, 0.0, 1.0); }`;
const SKY_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
${GLSL_COMMON}
uniform vec3 uNGP; uniform vec3 uGC; uniform vec3 uNEP; uniform vec3 uWave;
float sq(float x) { return x * x; }
void main() {
  vec2 p = gl_FragCoord.xy;
  float u = (p.x - uC.x) / (2.0 * uF), v = (p.y - uC.y) / (2.0 * uF), s = u * u + v * v;
  vec3 hv = (2.0 * u / (1.0 + s)) * uR + (2.0 * v / (1.0 + s)) * uU + ((1.0 - s) / (1.0 + s)) * uFw;
  vec3 e = hv * uM;   // transpose(M) * hv: back to equatorial
  float b = asin(clamp(dot(e, uNGP), -1.0, 1.0));
  float gc = acos(clamp(dot(e, uGC), -1.0, 1.0));
  float mott = 0.75 + 0.25 * sin(e.x * 23.0 + e.y * 9.0) * sin(e.y * 17.0 - e.z * 29.0) + 0.15 * sin(e.x * 61.0 - e.z * 47.0);
  float dust = 1.0 - 0.55 * exp(-sq(b / 0.03)) * (1.0 - uWave.x);
  float mw = (0.55 * exp(-sq(b / 0.17)) + 0.9 * exp(-sq(gc / 0.45))) * mott * dust * uWave.y;
  float beta = asin(clamp(dot(e, uNEP), -1.0, 1.0));
  float zodi = uWave.z * 0.35 * exp(-sq(beta / 0.45));
  vec3 c = vec3(2.0 + 70.0 * mw + 60.0 * zodi,
                4.0 + 72.0 * mw + 45.0 * zodi,
                9.0 + 90.0 * mw + 30.0 * zodi) / 255.0;
  gl_FragColor = vec4(c, 1.0);
}`;

const STAR_VS = `
precision highp float;
${GLSL_COMMON}
attribute vec3 aV; attribute vec2 aMT;
uniform vec2 uRes; uniform float uLimit; uniform float uZoom; uniform float uDpr;
uniform float uBandF[7]; uniform vec3 uCol[7];
varying vec3 vCol; varying float vA;
void main() {
  vA = 0.0; vCol = vec3(0.0); gl_PointSize = 0.0; gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  if (aMT.x > uLimit) return;
  vec3 h = uM * aV;
  float z = dot(h, uFw);
  if (z < -0.3) return;
  float k = 2.0 * uF / (1.0 + z);
  vec2 p = uC + k * vec2(dot(h, uR), dot(h, uU));
  gl_Position = vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0);
  float f = 1.0; vec3 col = vec3(1.0);
  for (int i = 0; i < 7; i++) { if (float(i) == aMT.y) { f = uBandF[i]; col = uCol[i]; } }
  vA = clamp((uLimit + 0.4 - aMT.x) / 5.5, 0.12, 1.0) * f;
  float r = max(0.6, (uLimit + 0.2 - aMT.x) * 0.42 * uZoom * (0.6 + 0.4 * f));
  gl_PointSize = 2.0 * r * uDpr + 2.0;
  vCol = col;
}`;
const STAR_FS = `
precision mediump float;
varying vec3 vCol; varying float vA;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = vA * (1.0 - smoothstep(0.35, 1.0, d));
  gl_FragColor = vec4(vCol * a, a);
}`;

function initGL(canvas) {
  if (Q.has('cpu')) return null;
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false, preserveDrawingBuffer: false });
  if (!gl) return null;
  const compile = (type, src) => {
    const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  };
  const program = (vs, fs) => {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name.replace('[0]', '');
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  };
  let sky, stars;
  try { sky = program(SKY_VS, SKY_FS); stars = program(STAR_VS, STAR_FS); }
  catch (err) { console.warn('WebGL shaders failed, using the slower fallback.', err); return null; }

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const starData = makeStars(30000);
  const starBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, starBuf);
  gl.bufferData(gl.ARRAY_BUFFER, starData, gl.STATIC_DRAW);
  const cols = new Float32Array(TEMP_RGB.flat().map(v => v / 255));

  function common(u) {
    // mat3 is column-major in GLSL: column j = (M[0][j], M[1][j], M[2][j]) so that uM * eq = M · eq
    gl.uniformMatrix3fv(u.uM, false, new Float32Array([M[0][0], M[1][0], M[2][0], M[0][1], M[1][1], M[2][1], M[0][2], M[1][2], M[2][2]]));
    gl.uniform3fv(u.uR, CR); gl.uniform3fv(u.uU, CU); gl.uniform3fv(u.uFw, CF);
    gl.uniform2f(u.uC, CX * DPR, (H - CY) * DPR);
    gl.uniform1f(u.uF, F * DPR);
  }

  return {
    kind: 'webgl',
    resize() { canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR); gl.viewport(0, 0, canvas.width, canvas.height); },
    render() {
      gl.disable(gl.BLEND);
      gl.useProgram(sky.p);
      common(sky.u);
      gl.uniform3fv(sky.u.uNGP, NGP); gl.uniform3fv(sky.u.uGC, GC); gl.uniform3fv(sky.u.uNEP, NEP);
      gl.uniform3fv(sky.u.uWave, waveParams());
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      const aP = gl.getAttribLocation(sky.p, 'aP');
      gl.enableVertexAttribArray(aP);
      gl.vertexAttribPointer(aP, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disableVertexAttribArray(aP);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(stars.p);
      common(stars.u);
      gl.uniform2f(stars.u.uRes, canvas.width, canvas.height);
      gl.uniform1f(stars.u.uLimit, limitMag());
      gl.uniform1f(stars.u.uZoom, zoomBoost());
      gl.uniform1f(stars.u.uDpr, DPR);
      gl.uniform1fv(stars.u.uBandF, BAND_F);
      gl.uniform3fv(stars.u.uCol, cols);
      gl.bindBuffer(gl.ARRAY_BUFFER, starBuf);
      const aV = gl.getAttribLocation(stars.p, 'aV'), aMT = gl.getAttribLocation(stars.p, 'aMT');
      gl.enableVertexAttribArray(aV); gl.enableVertexAttribArray(aMT);
      gl.vertexAttribPointer(aV, 3, gl.FLOAT, false, 20, 0);
      gl.vertexAttribPointer(aMT, 2, gl.FLOAT, false, 20, 12);
      gl.drawArrays(gl.POINTS, 0, starData.length / 5);
      gl.disableVertexAttribArray(aV); gl.disableVertexAttribArray(aMT);
    },
  };
}

// ---------------------------------------------------------------- CPU sky (fallback when WebGL is missing)

function initCPU(canvas) {
  const ctx = canvas.getContext('2d');
  const SCALE = 5;
  const bg = document.createElement('canvas'), bgx = bg.getContext('2d');
  const stars = makeStars(4000);
  return {
    kind: 'cpu',
    resize() {
      canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
      bg.width = Math.ceil(W / SCALE); bg.height = Math.ceil(H / SCALE);
    },
    render() {
      const w = bg.width, h = bg.height, img = bgx.createImageData(w, h), d = img.data;
      const [ln, mwGain, zodiGain] = waveParams();
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const hv = unproject((i + 0.5) * SCALE, (j + 0.5) * SCALE);
        const p = (j * w + i) * 4;
        d[p + 3] = 255;
        const e = toEq(hv);
        const b = Math.asin(clamp(dot(e, NGP), -1, 1)), gc = Math.acos(clamp(dot(e, GC), -1, 1));
        const dust = 1 - 0.55 * Math.exp(-((b / 0.03) ** 2)) * (1 - ln);
        const mw = (0.55 * Math.exp(-((b / 0.17) ** 2)) + 0.9 * Math.exp(-((gc / 0.45) ** 2))) * dust * mwGain;
        const zodi = zodiGain * 0.35 * Math.exp(-((Math.asin(clamp(dot(e, NEP), -1, 1)) / 0.45) ** 2));
        d[p] = 2 + 70 * mw + 60 * zodi; d[p + 1] = 4 + 72 * mw + 45 * zodi; d[p + 2] = 9 + 90 * mw + 30 * zodi;
      }
      bgx.putImageData(img, 0, 0);
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.drawImage(bg, 0, 0, W, H);
      const lim = limitMag(), zoom = zoomBoost();
      for (let k = 0; k < stars.length; k += 5) {
        const mag = stars[k + 3];
        if (mag > lim) continue;
        const h = toHor([stars[k], stars[k + 1], stars[k + 2]]);
        const p = project(h);
        if (!p || p[0] < 0 || p[1] < 0 || p[0] > W || p[1] > H) continue;
        const ti = stars[k + 4], f = BAND_F[ti];
        const a = clamp((lim + 0.4 - mag) / 5.5, 0.12, 1) * f;
        ctx.fillStyle = `rgba(${TEMP_RGB[ti].join()},${a})`;
        ctx.beginPath(); ctx.arc(p[0], p[1], Math.max(0.6, (lim + 0.2 - mag) * 0.42 * zoom), 0, 6.283); ctx.fill();
      }
    },
  };
}

const sky = initGL($('#dome-gl')) || initCPU($('#dome-gl'));

// ---------------------------------------------------------------- points of interest: index + filter

// Spatial index: points are grouped into cells of the unit sphere so we only look at cells in view.
let CELLS = [];
function buildIndex() {
  const SZ = 0.125, map = new Map();
  for (const p of S.pois) {
    const key = p.vec.map(c => Math.floor((c + 1) / SZ)).join();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p);
  }
  CELLS = [...map.values()].map(items => {
    const c = [0, 0, 0];
    for (const p of items) { c[0] += p.vec[0]; c[1] += p.vec[1]; c[2] += p.vec[2]; }
    const n = Math.hypot(...c) || 1;
    c[0] /= n; c[1] /= n; c[2] /= n;
    let r = 0;
    for (const p of items) r = Math.max(r, Math.acos(clamp(dot(c, p.vec), -1, 1)));
    items.sort((a, b) => b.size - a.size);
    return { c, r, items };
  });
}

function passesFilter(p) {
  if (!S.shown.has(p.category)) return false;
  if (S.onlyPatch && !p.patch) return false;
  if (S.search && !p._search.includes(S.search)) return false;
  return true;
}

function visiblePois() {
  const fEq = toEq(CF), view = viewRadius() + 0.05;
  const out = [];
  for (const cell of CELLS) {
    if (Math.acos(clamp(dot(cell.c, fEq), -1, 1)) - cell.r > view) continue;
    for (const p of cell.items) if (passesFilter(p) || p === S.selected) out.push(p);
  }
  if (out.length > MAX_DOTS) {
    out.sort((a, b) => b.size - a.size);
    out.length = MAX_DOTS;
    if (S.selected && !S.selected.custom && !out.includes(S.selected)) out.push(S.selected);
  }
  return out;
}

// ---------------------------------------------------------------- drawing the overlay

const SPRITES = {};
function glowSprite(color) {          // a soft glow per color, made once and reused
  if (SPRITES[color]) return SPRITES[color];
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d').createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, color + 'aa'); g.addColorStop(1, color + '00');
  const x = c.getContext('2d'); x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return (SPRITES[color] = c);
}

// Marker shapes: each type has its own shape, so color isn't the only clue.
function shapePath(ctx, shape, x, y, r) {
  ctx.beginPath();
  switch (shape) {
    case 'diamond': ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); break;
    case 'square': ctx.rect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6); break;
    case 'triangle': ctx.moveTo(x, y - r); ctx.lineTo(x + r * 0.95, y + r * 0.7); ctx.lineTo(x - r * 0.95, y + r * 0.7); ctx.closePath(); break;
    case 'hexagon': for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; ctx[i ? 'lineTo' : 'moveTo'](x + r * Math.cos(a), y + r * Math.sin(a)); } ctx.closePath(); break;
    case 'ellipse': ctx.ellipse(x, y, r * 1.25, r * 0.7, -0.5, 0, 6.283); break;
    case 'cross': ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); ctx.arc(x, y, r * 0.55, 0, 6.283); break;
    case 'ring': ctx.arc(x, y, r, 0, 6.283); ctx.moveTo(x + r * 1.5, y); ctx.ellipse(x, y, r * 1.5, r * 0.45, -0.3, 0, 6.283); break;
    default: ctx.arc(x, y, r, 0, 6.283);
  }
}

function catOf(p) { return S.cats[p.category] || { color: '#ffd27a', shape: 'circle', label: p.category }; }

const poiScreen = [];
function drawOverlay(now) {
  octx.setTransform(DPR, 0, 0, DPR, 0, 0);
  octx.clearRect(0, 0, W, H);
  if (S.grid) drawGrid();
  drawPoles();
  drawPois(now);
  if (S.selected?.custom) drawCustomTarget(now);
}

function drawGrid() {
  octx.strokeStyle = 'rgba(124,196,255,0.18)';
  octx.lineWidth = 1;
  const line = (pts) => {
    octx.beginPath();
    let pen = false;
    for (const h of pts) {
      const p = project(h);
      if (!p) { pen = false; continue; }
      pen ? octx.lineTo(p[0], p[1]) : octx.moveTo(p[0], p[1]); pen = true;
    }
    octx.stroke();
  };
  const dir = (a, al) => [Math.cos(al * D2R) * Math.sin(a * D2R), Math.cos(al * D2R) * Math.cos(a * D2R), Math.sin(al * D2R)];
  for (const al of [-60, -30, 0, 30, 60]) line(Array.from({ length: 121 }, (_, i) => dir(i * 3, al)));     // declination circles
  for (let a = 0; a < 360; a += 30) line(Array.from({ length: 45 }, (_, i) => dir(a, -88 + i * 4)));   // RA lines, every 2 hours
}

function drawPoles() {
  octx.font = '700 12px "Atkinson Hyperlegible Next", sans-serif';
  octx.textAlign = 'center';
  for (const [v, name] of [[[0, 0, 1], 'North celestial pole'], [[0, 0, -1], 'South celestial pole']]) {
    const p = project(toHor(v));
    if (!p || p[0] < 0 || p[0] > W || p[1] < 0 || p[1] > H) continue;
    octx.strokeStyle = 'rgba(255,200,87,0.8)'; octx.lineWidth = 1.5;
    octx.beginPath(); octx.moveTo(p[0] - 8, p[1]); octx.lineTo(p[0] + 8, p[1]); octx.moveTo(p[0], p[1] - 8); octx.lineTo(p[0], p[1] + 8); octx.stroke();
    octx.fillStyle = 'rgba(255,200,87,0.9)';
    octx.fillText(name, p[0], p[1] + 22);
  }
}

function drawPois(now) {
  poiScreen.length = 0;
  const zoom = clamp(Math.sqrt((60 * D2R) / S.fov), 0.8, 2.6);
  const placed = [];                                    // label boxes already used
  const labelQueue = [];
  const onScreen = [];
  for (const poi of visiblePois()) {
    const h = toHor(poi.vec);
    const p = project(h);
    if (!p || p[0] < -40 || p[1] < -40 || p[0] > W + 40 || p[1] > H + 40) continue;
    onScreen.push([poi, p]);
  }
  // Level of detail: with lots on screen, small objects become plain dots, one batch per color.
  const busy = onScreen.length > 250;
  const batches = {};
  for (const [poi, p] of onScreen) {
    if (!busy || poi.size >= 3 || poi === S.selected || poi === S.hover) continue;
    const col = catOf(poi).color;
    (batches[col] ||= []).push(p);
    poiScreen.push({ poi, x: p[0], y: p[1], r: 7 });
  }
  for (const [col, pts] of Object.entries(batches)) {
    octx.fillStyle = col;
    octx.beginPath();
    for (const [x, y] of pts) { octx.moveTo(x + 2.5, y); octx.arc(x, y, 2.5, 0, 6.283); }
    octx.fill();
  }
  for (const [poi, p] of onScreen) {
    if (busy && poi.size < 3 && poi !== S.selected && poi !== S.hover) continue;
    const ep = epochOf(poi);
    const f = clamp(bandFactor(poi) * (ep ? ep.ep.brightness : 1), 0, 1.3);
    const cat = catOf(poi);
    const r = (3 + poi.size * 1.8) * zoom * (0.35 + 0.65 * Math.sqrt(f));
    const sel = S.selected === poi, hov = S.hover === poi;
    const notYet = ep?.before;                          // chosen date is before its first image
    octx.globalAlpha = notYet ? 0.25 : 0.35 + 0.5 * Math.min(f, 1);
    const R = r * 3.2;
    octx.drawImage(glowSprite(cat.color), p[0] - R, p[1] - R, R * 2, R * 2);
    octx.globalAlpha = notYet ? 0.4 : 1;
    octx.fillStyle = '#fff';
    octx.beginPath(); octx.arc(p[0], p[1], Math.max(1.3, r * 0.4), 0, 6.283); octx.fill();
    octx.strokeStyle = cat.color;
    octx.lineWidth = sel ? 2.5 : 1.6;
    if (cat.shape === 'dashed' || notYet) octx.setLineDash([4, 3]);
    shapePath(octx, cat.shape, p[0], p[1], (r + 5) * (sel ? 1 + 0.15 * Math.sin(now / 350) : 1));
    octx.stroke();
    octx.setLineDash([]);
    if (sel || hov) {
      octx.strokeStyle = '#ffc857';
      octx.beginPath(); octx.arc(p[0], p[1], r + 12, 0, 6.283); octx.stroke();
    }
    octx.globalAlpha = 1;
    poiScreen.push({ poi, x: p[0], y: p[1], r: r + 10 });
    const few = onScreen.length <= 40;                  // e.g. after filtering: name everything
    if (S.labels && (sel || hov || few || poi.size >= 4 || S.fov < 70 * D2R)) labelQueue.push({ poi, x: p[0] + r + 9, y: p[1] + 4, sel, hov });
  }
  // labels: selected and hovered first, then biggest; skip any that would overlap
  labelQueue.sort((a, b) => (b.sel - a.sel) || (b.hov - a.hov) || (b.poi.size - a.poi.size));
  let n = 0;
  for (const L of labelQueue) {
    if (n >= MAX_LABELS && !L.sel && !L.hov) break;
    octx.font = `${L.sel ? 700 : 400} 13px "Atkinson Hyperlegible Next", sans-serif`;
    const w = octx.measureText(L.poi.name).width;
    const box = [L.x - 2, L.y - 12, w + 4, 16];
    if (!L.sel && !L.hov && placed.some(b => box[0] < b[0] + b[2] && b[0] < box[0] + box[2] && box[1] < b[1] + b[3] && b[1] < box[1] + box[3])) continue;
    placed.push(box);
    octx.fillStyle = '#000a'; octx.fillText(L.poi.name, L.x + 1, L.y + 1);
    octx.fillStyle = L.sel ? '#ffc857' : '#e8ecf6'; octx.fillText(L.poi.name, L.x, L.y);
    n++;
  }
}

function drawCustomTarget(now) {
  const t = S.selected, p = project(toHor(t.vec));
  if (!p) return;
  const r = 14 + 2 * Math.sin(now / 300);
  octx.strokeStyle = '#ffc857'; octx.lineWidth = 2;
  octx.beginPath(); octx.arc(p[0], p[1], r, 0, 6.283); octx.stroke();
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    octx.beginPath(); octx.moveTo(p[0] + dx * (r + 4), p[1] + dy * (r + 4)); octx.lineTo(p[0] + dx * (r + 14), p[1] + dy * (r + 14)); octx.stroke();
  }
  octx.font = '700 13px "Atkinson Hyperlegible Next", sans-serif';
  octx.fillStyle = '#ffc857'; octx.textAlign = 'left';
  octx.fillText(t.name, p[0] + r + 18, p[1] + 4);
}

function updateStatus() {
  const e = toEq(CF);
  const ra = ((Math.atan2(e[1], e[0]) * R2D) + 360) % 360, dec = Math.asin(clamp(e[2], -1, 1)) * R2D;
  $('#dome-status').innerHTML =
    `<strong>Looking at RA ${formatRA(ra).slice(0, 6)}, Dec ${formatDec(dec).slice(0, 4)}</strong><br>` +
    `${Math.round(S.fov * R2D)}° wide view · full 360° sky`;
}

// ---------------------------------------------------------------- loop: redraw only what changed

let lastKey = '', lastStatus = '';
const perf = { sky: 0, ov: 0, n: 0 };
function frame(now) {
  if (S.flight) stepFlight(now);
  const key = [S.az, S.alt, S.fov, S.allBands, S.band, W, H, panel.hidden, filterPanel.hidden].join();
  if (key !== lastKey) { lastKey = key; S.dirtySky = true; S.dirtyOverlay = true; }
  if (S.dirtySky || S.dirtyOverlay || S.selected) updateCamera();
  if (S.dirtySky) {
    const t = performance.now();
    sky.render();
    perf.sky = performance.now() - t;
    S.dirtySky = false;
  }
  if (S.dirtyOverlay || S.selected) {                 // the selected marker pulses
    const t = performance.now();
    drawOverlay(now);
    perf.ov = performance.now() - t;
    S.dirtyOverlay = false;
    const st = [Math.round(S.az * R2D * 4), Math.round(S.alt * R2D * 4), Math.round(S.fov * R2D)].join();
    if (st !== lastStatus) { lastStatus = st; updateStatus(); }
  }
  if (DEBUG && ++perf.n % 15 === 0) {
    $('#dome-debug').textContent = `${sky.kind} · sky ${perf.sky.toFixed(1)} ms · markers ${perf.ov.toFixed(1)} ms · ${S.pois.length} points`;
  }
  requestAnimationFrame(frame);
}

function resize() {
  DPR = Math.min(devicePixelRatio || 1, 2);
  W = dome.clientWidth; H = dome.clientHeight;
  overlay.width = Math.round(W * DPR); overlay.height = Math.round(H * DPR);
  updateCamera();
  sky.resize();
  S.dirtySky = S.dirtyOverlay = true;
  if (!panel.hidden) drawSpectrum();
}

// ---------------------------------------------------------------- flying

function wrapPi(a) { return ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; }

function flyTo(target, { fromWide = false } = {}) {
  const vec = eqVec(target.ra, target.dec);
  if (fromWide) {                 // arriving from a link: start zoomed out, facing away, then swing round
    const [alt, az] = horAltAz(toHor(vec));
    S.az = az + 150 * D2R; S.alt = clamp(-alt * 0.3, -60 * D2R, 60 * D2R); S.fov = 110 * D2R;
  }
  const endFov = target.fov ? clamp(target.fov * 30, 6, 30) * D2R : 14 * D2R;
  S.flight = { t0: performance.now(), dur: REDUCED ? 1 : (fromWide ? 4000 : 2800), vec,
               from: { az: S.az, alt: S.alt, fov: S.fov }, to: { fov: endFov } };
}

function stepFlight(now) {
  const fl = S.flight;
  const t = clamp((now - fl.t0) / fl.dur, 0, 1);
  if (fl.horizon) {
    const e = ease(t);
    S.fov = fl.from.fov + (100 * D2R - fl.from.fov) * e;      // "Wide view": zoom back out
    if (t >= 1) S.flight = null;
    return;
  }
  const turn = ease(clamp(t / 0.7, 0, 1));
  const zoomT = ease(clamp((t - 0.45) / 0.55, 0, 1));
  const [tAlt, tAz] = horAltAz(toHor(fl.vec));
  S.az = fl.from.az + wrapPi(tAz - fl.from.az) * turn;
  S.alt = fl.from.alt + (tAlt - fl.from.alt) * turn;
  const wide = Math.max(fl.from.fov, 80 * D2R);
  S.fov = t < 0.45 ? fl.from.fov + (wide - fl.from.fov) * ease(t / 0.45) : wide + (fl.to.fov - wide) * zoomT;
  if (t >= 1) S.flight = null;
}

// ---------------------------------------------------------------- shareable address

function updateUrl() {
  const q = new URLSearchParams();
  if (S.selected && !S.selected.custom) q.set('poi', S.selected.id);
  if (S.selected?.custom) { q.set('ra', S.selected.ra.toFixed(5)); q.set('dec', S.selected.dec.toFixed(5)); q.set('name', S.selected.name); }
  if (!S.allBands) q.set('band', S.band + 1);           // 1..102, same as on screen
  if (S.dateIdx !== null) q.set('date', iso(S.dates[S.dateIdx]));
  const all = Object.keys(S.cats);
  if (S.shown.size !== all.length) q.set('show', [...S.shown].join(','));
  if (Q.has('stress')) q.set('stress', Q.get('stress'));
  if (DEBUG) q.set('debug', '');
  history.replaceState(null, '', `dome.html${q.toString() ? '?' + q : ''}`);
}

// ---------------------------------------------------------------- image cache (dated 102-band cubes)

const IMG = new Map();
function cube(url) {
  if (!IMG.has(url)) IMG.set(url, loadImage(`data/${url}`).catch(() => null));
  return IMG.get(url);
}
const STACKED = new Map();
function stacked(url, img) {          // all 102 tiles averaged: "all bands added together"
  if (STACKED.has(url)) return STACKED.get(url);
  const T = S.layout.tile_px;
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const cx = c.getContext('2d'); cx.drawImage(img, 0, 0);
  const all = cx.getImageData(0, 0, c.width, c.height).data;
  const out = new ImageData(T, T);
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
    let s = 0;
    for (let r = 0; r < 6; r++) for (let k = 0; k < 17; k++) s += all[((r * T + y) * c.width + k * T + x) * 4];
    const p = (y * T + x) * 4;
    out.data[p] = out.data[p + 1] = out.data[p + 2] = Math.min(255, s / 102 * 1.3); out.data[p + 3] = 255;
  }
  const t = document.createElement('canvas'); t.width = T; t.height = T;
  t.getContext('2d').putImageData(out, 0, 0);
  STACKED.set(url, t);
  return t;
}

// ---------------------------------------------------------------- point-of-interest panel

function selectPoi(poi, { fly = true } = {}) {
  S.selected = poi;
  if (fly) flyTo(poi);
  updateUrl();
  renderPanel();
  renderObjList();
  S.dirtyOverlay = true;
}

function selectCustom(ra, dec, name, fov) {
  S.selected = { custom: true, ra, dec, name: name || `${formatRA(ra)} ${formatDec(dec)}`, vec: eqVec(ra, dec), fov };
  renderPanel();
}

function closePanel() {
  stopDateBlink();
  S.selected = null; panel.hidden = true; updateUrl(); renderObjList(); S.dirtyOverlay = true;
}

function renderPanel() {
  const t = S.selected;
  if (!t) { panel.hidden = true; return; }
  panel.hidden = false;
  const close = `<button class="close" type="button" aria-label="Close">✕</button>`;
  const copy = `<button type="button" data-copy>Copy link</button>`;
  if (t.custom || !t.spectrum) {
    const viewer = viewerUrl({ ra: t.ra, dec: t.dec, fov: t.fov || 0.25, name: t.name });
    panel.innerHTML = `
      <header><div><span class="pill pill-brand">${t.custom ? 'Your target' : 'Test point'}</span><h2 id="poi-name"></h2></div>${close}</header>
      <p class="mono small muted">${formatRA(t.ra)} · ${formatDec(t.dec)}</p>
      <p class="blurb">${t.custom ? 'No 102-band data for this exact spot yet. When SPHEREx spectra are added for it, they’ll show here.' : 'A made-up point added to test speed with lots of data.'}</p>
      <div class="poi-actions"><a class="btn primary" href="${viewer}">Open in Viewer</a>${copy}</div>`;
    panel.querySelector('#poi-name').textContent = t.name;
    wirePanelCommon();
    return;
  }
  const cat = catOf(t);
  panel.innerHTML = `
    <header><div><span class="pill" style="color:${cat.color};border-color:${cat.color}66">${t.type}</span>
      <h2 id="poi-name"></h2></div>${close}</header>
    <p class="mono small muted">${formatRA(t.ra)} · ${formatDec(t.dec)}</p>
    <p class="blurb"></p>
    <h3>Seen in 102 infrared bands</h3>
    <div class="band-view"><canvas id="band-canvas" width="240" height="240" role="img" aria-label=""></canvas>
      ${t.simulated === false ? '<span class="badge">SPHEREx data</span>' : '<span class="badge badge-warn">Simulated</span>'}
      <span class="badge badge-date mono" id="band-badge"></span></div>
    <div class="band-caption"><span id="band-cap"></span>
      <label class="check small"><input type="checkbox" id="false-color" checked> False color</label></div>

    <h3>Dates <span class="muted" style="text-transform:none;letter-spacing:0" id="date-count"></span></h3>
    <div class="dates">
      <div class="date-chips" id="date-chips" role="group" aria-label="Observation dates"></div>
      <div class="date-ctrl">
        <button type="button" id="ep-prev" aria-label="Earlier date">◀</button>
        <button type="button" id="ep-next" aria-label="Later date">▶</button>
        <button type="button" id="ep-blink" aria-pressed="false">▶ Sweep this object's dates</button>
      </div>
      <canvas class="lightcurve" id="lightcurve" aria-label="Brightness at each date"></canvas>
    </div>

    <h3>All bands at once <span class="muted" style="text-transform:none;letter-spacing:0">(click one)</span></h3>
    <div class="band-grid" id="band-grid"><img alt="Grid of 102 small images, one per band, for the chosen date"><div class="hl" id="band-hl"></div></div>
    <h3>Spectrum <span class="muted" style="text-transform:none;letter-spacing:0">(click to pick a band)</span></h3>
    <canvas class="spec-chart" id="spec-chart"></canvas>
    <p class="muted small" style="margin:6px 0 0">Brightness at each wavelength. Dips and bumps reveal molecules like water, methane and ices.</p>
    <div class="poi-actions">
      ${t.patch ? `<a class="btn primary" href="${viewerUrl({ ra: t.ra, dec: t.dec, fov: 0.25, name: t.name })}">Open in Viewer</a>` : ''}
      ${copy}
    </div>`;
  panel.querySelector('#poi-name').textContent = t.name;
  panel.querySelector('.blurb').textContent = t.blurb;
  wirePanelCommon();

  panel.querySelector('#false-color').addEventListener('change', drawBandTile);
  const grid = panel.querySelector('#band-grid');
  grid.addEventListener('click', (e) => {
    const r = grid.getBoundingClientRect();
    setBand(clamp(Math.floor((e.clientY - r.top) / r.height * 6), 0, 5) * 17 + clamp(Math.floor((e.clientX - r.left) / r.width * 17), 0, 16));
  });
  const chart = panel.querySelector('#spec-chart');
  chart.addEventListener('click', (e) => {
    const r = chart.getBoundingClientRect();
    const lam = 0.7 + (e.clientX - r.left - 30) / (r.width - 40) * 4.4;
    let best = 0;
    S.bands.forEach((b, i) => { if (Math.abs(b.center_um - lam) < Math.abs(S.bands[best].center_um - lam)) best = i; });
    setBand(best);
  });
  panel.querySelector('#ep-prev').addEventListener('click', () => stepEpoch(-1));
  panel.querySelector('#ep-next').addEventListener('click', () => stepEpoch(1));
  panel.querySelector('#ep-blink').addEventListener('click', () => toggleDateBlink());
  const lc = panel.querySelector('#lightcurve');
  lc.addEventListener('click', (e) => {
    const r = lc.getBoundingClientRect(), eps = t.epochs;
    const x = (e.clientX - r.left) / r.width;
    const m0 = eps[0].mjd, m1 = eps.at(-1).mjd || m0 + 1;
    let best = 0;
    eps.forEach((ep, i) => { if (Math.abs((ep.mjd - m0) / (m1 - m0 || 1) - x) < Math.abs((eps[best].mjd - m0) / (m1 - m0 || 1) - x)) best = i; });
    goToEpoch(best);
  });

  panel.querySelector('#date-count').textContent = `(observed ${t.epochs.length} time${t.epochs.length === 1 ? '' : 's'})`;
  t.epochs.forEach(ep => cube(ep.cube));             // preload every date for smooth sweeping
  renderDateChips();
  updatePanelBand();
  drawSpectrum();
}

function wirePanelCommon() {
  panel.querySelector('.close').addEventListener('click', closePanel);
  panel.querySelector('[data-copy]').addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText(location.href); e.target.textContent = 'Link copied'; }
    catch { e.target.textContent = 'Copy failed'; }
    setTimeout(() => { e.target.textContent = 'Copy link'; }, 1500);
  });
}

function renderDateChips() {
  const t = S.selected, box = panel.querySelector('#date-chips');
  if (!box || !t?.epochs) return;
  const cur = epochOf(t);
  box.innerHTML = '';
  t.epochs.forEach((ep, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = mjdToShort(ep.mjd);
    b.title = iso(ep.mjd);
    b.setAttribute('aria-label', `Show ${iso(ep.mjd)}`);
    b.setAttribute('aria-current', String(!cur.before && cur.i === i));
    b.addEventListener('click', () => goToEpoch(i));
    box.append(b);
  });
  drawLightcurve();
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

async function drawBandTile() {
  const t = S.selected, canvas = panel.querySelector('#band-canvas');
  if (!canvas || !t?.epochs) return;
  const cur = epochOf(t), url = cur.ep.cube;
  const img = await cube(url);
  if (S.selected !== t || epochOf(t).ep.cube !== url) return;   // something changed while loading
  const c = canvas.getContext('2d');
  c.imageSmoothingEnabled = false;
  c.fillStyle = '#000'; c.fillRect(0, 0, 240, 240);
  if (!img) return;
  const T = S.layout.tile_px;
  if (S.allBands) c.drawImage(stacked(url, img), 0, 0, 240, 240);
  else {
    const b = S.bands[S.band];
    c.drawImage(img, b.channel * T, (b.detector - 1) * T, T, T, 0, 0, 240, 240);
    if (panel.querySelector('#false-color')?.checked) {
      c.globalCompositeOperation = 'multiply';
      c.fillStyle = `rgb(${bandRGB(S.band).join()})`;
      c.fillRect(0, 0, 240, 240);
      c.globalCompositeOperation = 'source-over';
    }
  }
  if (cur.before) { c.fillStyle = '#000a'; c.fillRect(0, 0, 240, 240); }
  canvas.setAttribute('aria-label', `${t.name} on ${iso(cur.ep.mjd)}, ${S.allBands ? 'all bands' : S.bands[S.band].center_um.toFixed(2) + ' micrometers'}`);
  const gridImg = panel.querySelector('#band-grid img');
  if (gridImg.getAttribute('src') !== `data/${url}`) gridImg.src = `data/${url}`;
}

function sizeCanvas(c) {
  const r = c.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
  if (c.width !== Math.round(r.width * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
  const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [x, r.width, r.height];
}

function drawSpectrum() {
  const chart = panel.querySelector('#spec-chart'), t = S.selected;
  if (!chart || !t?.spectrum) return;
  const [c, w, h] = sizeCanvas(chart);
  c.clearRect(0, 0, w, h);
  const L = 30, B = 22, Tp = 18;
  const X = (lam) => L + (lam - 0.7) / 4.4 * (w - L - 10);
  const Y = (v) => h - B - v * (h - B - Tp);
  c.strokeStyle = '#33405f'; c.fillStyle = '#9aa6bf'; c.font = '11px "Atkinson Hyperlegible Mono", monospace'; c.textAlign = 'center';
  for (let um = 1; um <= 5; um++) {
    c.beginPath(); c.moveTo(X(um), h - B); c.lineTo(X(um), h - B + 4); c.stroke();
    c.fillText(`${um} µm`, X(um), h - 6);
  }
  c.beginPath(); c.moveTo(L, h - B); c.lineTo(w - 8, h - B); c.stroke();
  (FEATURES[t.spectrum_model] || []).forEach(([lam, name], i, all) => {
    const crowded = i > 0 && X(lam) - X(all[i - 1][0]) < 40;
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

function drawLightcurve() {
  const lc = panel.querySelector('#lightcurve'), t = S.selected;
  if (!lc || !t?.epochs) return;
  const [c, w, h] = sizeCanvas(lc);
  c.clearRect(0, 0, w, h);
  const eps = t.epochs, m0 = eps[0].mjd, m1 = eps.at(-1).mjd;
  const bmax = Math.max(...eps.map(e => e.brightness), 1);
  const X = (m) => 12 + (m1 > m0 ? (m - m0) / (m1 - m0) : 0.5) * (w - 24);
  const Y = (v) => h - 12 - v / bmax * (h - 24);
  c.strokeStyle = '#7cc4ff88'; c.lineWidth = 1.5;
  c.beginPath(); eps.forEach((e, i) => c[i ? 'lineTo' : 'moveTo'](X(e.mjd), Y(e.brightness))); c.stroke();
  const cur = epochOf(t);
  eps.forEach((e, i) => {
    const on = !cur.before && cur.i === i;
    c.fillStyle = on ? '#ffc857' : '#7cc4ff';
    c.beginPath(); c.arc(X(e.mjd), Y(e.brightness), on ? 5 : 3, 0, 6.283); c.fill();
  });
  c.fillStyle = '#9aa6bf'; c.font = '10px "Atkinson Hyperlegible Mono", monospace';
  c.textAlign = 'left'; c.fillText(iso(m0), 4, h - 2);
  c.textAlign = 'right'; c.fillText(iso(m1), w - 4, h - 2);
  c.textAlign = 'left'; c.fillText('brightness', 4, 10);
}

function updatePanelBand() {
  const t = S.selected;
  if (!t || t.custom || !t.spectrum || panel.hidden) return;
  const b = S.bands[S.band];
  const cur = epochOf(t);
  const hl = panel.querySelector('#band-hl');
  hl.hidden = S.allBands;
  hl.style.left = `${b.channel / 17 * 100}%`; hl.style.top = `${(b.detector - 1) / 6 * 100}%`;
  hl.style.width = `${100 / 17}%`; hl.style.height = `${100 / 6}%`;
  panel.querySelector('#band-badge').textContent =
    `${iso(cur.ep.mjd)} · ${S.allBands ? 'all bands' : b.center_um.toFixed(2) + ' µm'}`;
  panel.querySelector('#band-cap').textContent = cur.before
    ? `Not observed yet on this date. First image: ${iso(t.epochs[0].mjd)}`
    : S.allBands ? 'All bands added together'
    : `Band ${S.band + 1} of 102 · detector ${b.detector} · ${Math.round(t.spectrum[S.band] * cur.ep.brightness * 100)}% bright`;
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
  $('#band-row').classList.toggle('all-bands', S.allBands);
  $('#wave-read').textContent = S.allBands
    ? 'All 102 bands · 0.75–5.0 µm'
    : `${b.center_um.toFixed(2)} µm · band ${S.band + 1}/102 · detector ${b.detector}`;
  updateBandFactors();
  updatePanelBand();
  S.dirtySky = S.dirtyOverlay = true;
  if (!S.bandTimer) updateUrl();
}

function stopBandBlink() {
  clearInterval(S.bandTimer); S.bandTimer = null;
  $('#band-blink').setAttribute('aria-pressed', 'false');
  $('#band-blink').textContent = '▶ Sweep bands';
}

$('#band').addEventListener('input', (e) => setBand(+e.target.value));
$('#all-bands').addEventListener('click', () => { stopBandBlink(); S.allBands = !S.allBands; syncWave(); });
$('#band-blink').addEventListener('click', () => {
  if (S.bandTimer) { stopBandBlink(); updateUrl(); return; }
  stopDateBlink();
  if (S.allBands) setBand(0);
  $('#band-blink').setAttribute('aria-pressed', 'true');
  $('#band-blink').textContent = '❚❚ Pause';
  S.bandTimer = setInterval(() => setBand((S.band + 1) % 102, { keepBlink: true }), 160);
});

// ---------------------------------------------------------------- date bar

function setDateIdx(i, { keepBlink = false } = {}) {
  if (!keepBlink) stopDateBlink();
  S.dateIdx = i === null ? null : clamp(i, 0, S.dates.length - 1);
  syncDate();
}

function syncDate() {
  const latest = S.dateIdx === null;
  $('#date').value = latest ? S.dates.length - 1 : S.dateIdx;
  $('#latest').setAttribute('aria-pressed', String(latest));
  $('#date-row').classList.toggle('latest', latest);
  if (latest) $('#date-read').textContent = `Latest image of each object (to ${iso(S.dates.at(-1))})`;
  else {
    const m = S.dates[S.dateIdx];
    const seen = S.pois.filter(p => p.epochs?.length && p.epochs[0].mjd <= m + 0.5).length;
    $('#date-read').textContent = `${iso(m)} · ${seen} of ${S.pois.length} observed by then`;
  }
  renderDateChips();
  updatePanelBand();
  S.dirtyOverlay = true;
  if (!S.dateTimer) updateUrl();
}

// Step through the selected object's own dates (or every survey date if nothing is selected).
function goToEpoch(i, opts) {
  const t = S.selected;
  if (!t?.epochs) return;
  const m = t.epochs[clamp(i, 0, t.epochs.length - 1)].mjd;
  setDateIdx(S.dates.findIndex(d => Math.abs(d - m) < 0.5), opts);
}
function stepEpoch(d, opts) {
  const t = S.selected;
  if (t?.epochs) {
    const cur = epochOf(t);
    const n = t.epochs.length;
    goToEpoch(cur.before ? 0 : (cur.i + d + n) % n, opts);
  } else {
    const n = S.dates.length;
    setDateIdx(S.dateIdx === null ? 0 : (S.dateIdx + d + n) % n, opts);
  }
}

function toggleDateBlink() {
  if (S.dateTimer) { stopDateBlink(); updateUrl(); return; }
  stopBandBlink();
  for (const b of [$('#date-blink'), panel.querySelector('#ep-blink')]) {
    if (!b) continue;
    b.setAttribute('aria-pressed', 'true');
  }
  $('#date-blink').textContent = '❚❚ Pause';
  const eb = panel.querySelector('#ep-blink'); if (eb) eb.textContent = '❚❚ Pause';
  stepEpoch(1, { keepBlink: true });
  S.dateTimer = setInterval(() => stepEpoch(1, { keepBlink: true }), 700);
}
function stopDateBlink() {
  clearInterval(S.dateTimer); S.dateTimer = null;
  $('#date-blink').setAttribute('aria-pressed', 'false');
  $('#date-blink').textContent = '▶ Sweep dates';
  const eb = panel.querySelector('#ep-blink');
  if (eb) { eb.setAttribute('aria-pressed', 'false'); eb.textContent = '▶ Sweep this object\'s dates'; }
}

$('#date').addEventListener('input', (e) => setDateIdx(+e.target.value));
$('#latest').addEventListener('click', () => setDateIdx(S.dateIdx === null ? S.dates.length - 1 : null));
$('#date-blink').addEventListener('click', toggleDateBlink);

// ---------------------------------------------------------------- filter panel

function shapeIcon(cat) {
  const c = document.createElement('canvas');
  c.width = c.height = 40; c.style.width = c.style.height = '20px';
  const x = c.getContext('2d');
  x.strokeStyle = cat.color; x.fillStyle = '#fff'; x.lineWidth = 3;
  if (cat.shape === 'dashed') x.setLineDash([6, 4]);
  shapePath(x, cat.shape, 20, 20, 12); x.stroke();
  x.beginPath(); x.arc(20, 20, 4, 0, 6.283); x.fill();
  return c;
}

function renderCatList() {
  const counts = {};
  for (const p of S.pois) counts[p.category] = (counts[p.category] || 0) + 1;
  const box = $('#cat-list');
  box.innerHTML = '';
  for (const [id, cat] of Object.entries(S.cats)) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = S.shown.has(id); cb.value = id;
    cb.addEventListener('change', () => { cb.checked ? S.shown.add(id) : S.shown.delete(id); filtersChanged(); });
    const name = document.createElement('span'); name.textContent = cat.label;
    const n = document.createElement('span'); n.className = 'n'; n.textContent = counts[id] || 0;
    label.append(cb, shapeIcon(cat), name, n);
    box.append(label);
  }
}

function renderObjList() {
  const list = S.pois.filter(passesFilter);
  $('#shown-count').textContent = `${list.length}`;
  if (filterPanel.hidden) return;
  $('#obj-count').textContent = `${list.length} of ${S.pois.length} objects shown`;
  const ul = $('#obj-list');
  ul.innerHTML = '';
  const MAXL = 300;   // keep the list fast with huge catalogs
  for (const p of list.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name)).slice(0, MAXL)) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-current', String(S.selected === p));
    const t = document.createElement('span'); t.className = 't'; t.textContent = p.type;
    const name = document.createElement('span'); name.textContent = p.name;
    b.append(shapeIcon(catOf(p)), name, t);
    b.addEventListener('click', () => selectPoi(p));
    li.append(b);
    ul.append(li);
  }
  if (list.length > MAXL) ul.insertAdjacentHTML('beforeend', `<li class="muted small">…and ${list.length - MAXL} more. Search to narrow down.</li>`);
}

function filtersChanged() {
  renderObjList();
  S.dirtyOverlay = true;
  updateUrl();
}

function openFilter(open) {
  filterPanel.hidden = !open;
  $('#open-filter').setAttribute('aria-expanded', String(open));
  if (open) { renderCatList(); renderObjList(); $('#obj-search').focus(); }
  else $('#open-filter').focus();
}
$('#open-filter').addEventListener('click', () => openFilter(filterPanel.hidden));
$('#close-filter').addEventListener('click', () => openFilter(false));
$('#obj-search').addEventListener('input', (e) => { S.search = e.target.value.trim().toLowerCase(); filtersChanged(); });
$('#only-patch').addEventListener('change', (e) => { S.onlyPatch = e.target.checked; filtersChanged(); });
$('#cats-all').addEventListener('click', () => { S.shown = new Set(Object.keys(S.cats)); renderCatList(); filtersChanged(); });
$('#cats-none').addEventListener('click', () => { S.shown.clear(); renderCatList(); filtersChanged(); });
filterPanel.addEventListener('keydown', (e) => { if (e.key === 'Escape') openFilter(false); });

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
  S.alt = clamp(S.alt + dy * k, -89.5 * D2R, 89.5 * D2R);   // straight up to straight down
}
function zoomBy(f) { S.flight = null; S.fov = clamp(S.fov * f, 4 * D2R, 140 * D2R); }

overlay.addEventListener('pointerdown', (e) => {
  overlay.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
  if (pointers.size === 1) drag = { moved: 0 };
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), fov: S.fov };
  }
  hideHint();
});
overlay.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) {
    const h = hitPoi(e.offsetX, e.offsetY);
    if (h !== S.hover) { S.hover = h; S.dirtyOverlay = true; dome.classList.toggle('over-poi', !!h); }
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
overlay.addEventListener('pointerup', endPointer);
overlay.addEventListener('pointercancel', endPointer);
overlay.addEventListener('wheel', (e) => { e.preventDefault(); hideHint(); zoomBy(Math.exp(e.deltaY * 0.0012)); }, { passive: false });
overlay.addEventListener('keydown', (e) => {
  const k = { ArrowLeft: () => look(40, 0), ArrowRight: () => look(-40, 0), ArrowUp: () => look(0, 40),
              ArrowDown: () => look(0, -40), '+': () => zoomBy(0.85), '=': () => zoomBy(0.85), '-': () => zoomBy(1.18) }[e.key];
  if (k) { e.preventDefault(); k(); hideHint(); }
});

$('#zoom-in').addEventListener('click', () => zoomBy(0.7));
$('#zoom-out').addEventListener('click', () => zoomBy(1.4));
$('#reset-view').addEventListener('click', () => {
  S.flight = { t0: performance.now(), dur: REDUCED ? 1 : 1500, from: { az: S.az, alt: S.alt, fov: S.fov }, horizon: true };
});
$('#show-labels').addEventListener('change', (e) => { S.labels = e.target.checked; S.dirtyOverlay = true; });
$('#show-grid').addEventListener('change', (e) => { S.grid = e.target.checked; S.dirtyOverlay = true; });

let hintTimer;
function hideHint() { $('#dome-hint').classList.add('gone'); clearTimeout(hintTimer); }

let idleTimer;
function wake() {
  dome.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => dome.classList.add('idle'), 2500);
}
for (const ev of ['mousemove', 'keydown', 'touchstart', 'focusin']) dome.addEventListener(ev, wake);

// ---------------------------------------------------------------- start

function addStressPoints(n) {      // ?stress=20000: fake points to test speed with a big catalog
  const cats = Object.keys(S.cats);
  let s = 99;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < n; i++) {
    const ra = rand() * 360, dec = Math.asin(rand() * 2 - 1) * R2D;
    S.pois.push({ id: `test${i}`, name: `Test point ${i + 1}`, category: cats[Math.floor(rand() * cats.length)],
                  type: 'Test point', ra, dec, size: rand() < 0.02 ? 3 : rand() < 0.3 ? 2 : 1, blurb: '' });
  }
}

(async function start() {
  if (DEBUG) dome.insertAdjacentHTML('beforeend', '<div class="dome-glass dome-debug" id="dome-debug"></div>');
  updateMatrix();
  resize();
  addEventListener('resize', resize);
  wake();
  hintTimer = setTimeout(hideHint, 6000);

  try {
    const [poiData, bandData] = await Promise.all([loadJSON('data/dome/poi.json'), loadJSON('data/dome/bands.json')]);
    S.pois = poiData.pois;
    S.cats = poiData.categories || FALLBACK_CATS;
    S.layout = poiData.cube_layout;
    S.bands = bandData.bands;
  } catch (err) {
    console.error(err);
    S.bands = Array.from({ length: 102 }, (_, i) => ({ index: i, detector: Math.floor(i / 17) + 1, channel: i % 17,
      center_um: 0.75 * (5 / 0.75) ** ((i + 0.5) / 102) }));
  }
  if (Q.has('stress')) addStressPoints(clamp(+Q.get('stress') || 10000, 0, 200000));
  for (const p of S.pois) {
    p.vec = eqVec(p.ra, p.dec);
    p._search = `${p.name} ${p.type} ${S.cats[p.category]?.label || ''}`.toLowerCase();
    if (p.spectrum) p._mean = p.spectrum.reduce((a, b) => a + b, 0) / p.spectrum.length / Math.max(...p.spectrum) * 1.4;
    if (!S.cats[p.category]) S.cats[p.category] = { label: p.category, color: '#ffd27a', shape: 'circle' };
  }
  buildIndex();

  // every observation date across all objects, one per day
  const all = S.pois.flatMap(p => (p.epochs || []).map(e => e.mjd)).sort((a, b) => a - b);
  S.dates = all.filter((m, i) => i === 0 || m - all[i - 1] > 0.5);
  if (!S.dates.length) S.dates = [61300];
  $('#date').max = S.dates.length - 1;

  // filters and state from the address
  S.shown = new Set(Q.get('show') ? Q.get('show').split(',').filter(c => S.cats[c]) : Object.keys(S.cats));
  if (Q.has('band')) { S.band = clamp((+Q.get('band') || 1) - 1, 0, 101); S.allBands = false; }
  if (Q.get('date')) {
    const want = Q.get('date');
    const i = S.dates.findLastIndex(m => iso(m) <= want);
    S.dateIdx = i < 0 ? 0 : i;
  }

  $('#det-strip').innerHTML = DET_COLORS.map((c, i) => {
    const lo = S.bands[i * 17].center_um, hi = S.bands[i * 17 + 16].center_um;
    return `<span style="background:${c}" title="Detector ${i + 1}: ${lo.toFixed(2)}–${hi.toFixed(2)} µm">${i + 1}</span>`;
  }).join('');
  syncWave();
  syncDate();
  renderObjList();
  requestAnimationFrame(frame);

  // Arriving from a link: start zoomed out and facing away, then turn and zoom to the target.
  const byId = S.pois.find(p => p.id === Q.get('poi'));
  const ra = parseRA(Q.get('ra') ?? ''), dec = parseDec(Q.get('dec') ?? '');
  if (byId) {
    S.selected = byId; renderPanel();
    flyTo(byId, { fromWide: true });
  } else if (ra !== null && dec !== null) {
    const near = S.pois.find(p => p.spectrum && separation(ra, dec, p.ra, p.dec) < 0.5);
    if (near) { S.selected = near; renderPanel(); }
    else selectCustom(ra, dec, Q.get('name'), Number(Q.get('fov')) || 0.25);
    flyTo({ ra, dec }, { fromWide: true });
  }
  updateUrl();
})();
