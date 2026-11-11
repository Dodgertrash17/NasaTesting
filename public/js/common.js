// Shared by every page: site name, nav bar, footer, and sky-coordinate helpers.
// Pages load this first:  <script src="js/common.js" defer></script>

const SITE = {
  name: 'SkyBlink',                                  // working title: change it here and in each page <title>
  tagline: 'An astronomy blinker for NASA SPHEREx',
};

// Top-middle tabs on every page. `section` matches <body data-page="...">.
const NAV = [
  { href: 'index.html',  label: 'Home',        section: 'home' },
  { href: 'learn.html',  label: 'Education',   section: 'learn' },
  { href: 'search.html', label: 'Search Tool', section: 'search' },   // viewer.html counts as Search Tool
  { href: 'dome.html',   label: 'Sky Dome',    section: 'dome' },
  { href: 'about.html',  label: 'About',       section: 'about' },
];

// The five challenge test targets. Shared by the search page and the viewer.
// ra/dec are the catalogue position at `epoch` (decimal year); pm is proper motion in
// arcsec/yr as [mu_ra * cos(dec), mu_dec]. Values are approximate: verify in SIMBAD.
// `fov` is the field of view (degrees) a preset opens with: fast movers get a wider field
// because they are no longer at their catalogue position.
const TARGETS = [
  { id: 'barnard',  name: "Barnard's Star", ra: 269.4521, dec: 4.6934,   epoch: 2000, pm: [-0.80, 10.33],
    fov: 15 / 60, kind: 'mover',    note: 'Fastest-moving star in our sky: about 10″ a year, so 2 to 3 SPHEREx pixels across the survey.' },
  { id: 'epsindib', name: 'Epsilon Indi B', ra: 331.0438, dec: -56.7827, epoch: 2000, pm: [3.98, -2.47],
    fov: 10 / 60, kind: 'mover',    note: 'Two brown dwarfs about 1″ apart, so they show as one dot. Moves about 4.7″ a year.' },
  { id: 'wise0855', name: 'WISE 0855',      ra: 133.7951, dec: -7.2451,  epoch: 2014, pm: [-8.05, 0.66],
    fov: 10 / 60, kind: 'mover',    gaia: false, note: 'The coldest known brown dwarf. Very faint: look at the longest-wavelength detector and the stack.' },
  { id: 'rwaur',    name: 'RW Aurigae',     ra: 76.9563,  dec: 30.4013,  epoch: 2000, pm: [0, 0],
    fov: 5 / 60,  kind: 'variable', note: 'A young star that dims irregularly. Watch the brightness chart, not the position.' },
  { id: 'rdra',     name: 'R Draconis',     ra: 248.1675, dec: 66.7551,  epoch: 2000, pm: [0, 0],
    fov: 5 / 60,  kind: 'variable', note: 'A pulsating giant (Mira variable) with a ~245-day cycle. Bright: check the saturation flags.' },
];

// Field-of-view choices (degrees). Bigger fields catch faster movers but download more.
const FOV_OPTIONS = [2, 5, 10, 15, 30, 60].map(m => ({ deg: m / 60, label: m < 60 ? `${m}′` : '1°' }));

function formatFov(deg) {
  const m = deg * 60;
  return m >= 60 ? `${+(m / 60).toFixed(2)}°` : `${+m.toFixed(1)}′`;
}

// Find a preset target near a position (within ~36″).
function knownTarget(ra, dec) {
  return TARGETS.find(t => separation(ra, dec, t.ra, t.dec) < 0.01) || null;
}

// ---------- header + footer ----------

// ?embed=1 hides the site header and footer so a page can sit inside an <iframe>.
const EMBED = new URLSearchParams(location.search).get('embed') === '1';

function renderChrome() {
  const page = document.body.dataset.page;
  if (EMBED) {
    document.body.classList.add('embed');
    for (const el of document.querySelectorAll('#site-header, #site-footer')) el.remove();
    return;
  }
  const header = document.querySelector('#site-header');
  if (header) {
    header.className = 'site-header';
    header.innerHTML = `
      <a class="brand" href="index.html">
        <span class="brand-mark" aria-hidden="true"></span>
        <span>${SITE.name}</span>
      </a>
      <nav aria-label="Main">
        <ul>${NAV.map(n => `
          <li><a href="${n.href}"${n.section === page ? ' aria-current="page"' : ''}>${n.label}</a></li>`).join('')}
        </ul>
      </nav>
      <span class="header-spacer" aria-hidden="true"></span>`;
  }
  const footer = document.querySelector('#site-footer');
  if (footer) {
    footer.className = 'site-footer';
    footer.innerHTML = `<span>${SITE.name}: ${SITE.tagline}</span>
      <span>Data: SPHEREx/JPL/Caltech/NASA, via NASA/IPAC IRSA</span>`;
  }
}
renderChrome();

// ---------- small helpers ----------

// Data files give times as MJD (days since 1858-11-17). 40587 is 1970-01-01.
function mjdToDate(mjd) {
  return new Date((mjd - 40587) * 86400000).toISOString().slice(0, 10);   // "2025-05-01"
}

function mjdToShort(mjd) {   // "May '25"
  const d = new Date((mjd - 40587) * 86400000);
  return d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) + ` '${String(d.getUTCFullYear()).slice(2)}`;
}

async function loadJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// Uses the load event rather than img.decode(): decode() can wait indefinitely in background tabs.
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${src}`));
    img.src = src;
  });
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

function mjdToYear(mjd) {
  return 2000 + (mjd - 51544.5) / 365.25;
}

// Move a catalogue position along its proper motion. pm = [mu_ra*cos(dec), mu_dec] in arcsec/yr.
// Good to well under an arcsecond over decades; use astropy's apply_space_motion in the pipeline.
function propagate(ra, dec, pm, fromYear, toYear) {
  if (!pm) return { ra, dec };
  const dt = toYear - fromYear;
  const d = dec + (pm[1] * dt) / 3600;
  const r = ra + (pm[0] * dt) / 3600 / Math.cos(dec * Math.PI / 180);
  return { ra: (r + 360) % 360, dec: d };
}

// Build a viewer link. Everything the viewer shows can be described in its URL, so links can
// be shared and the page can be embedded: viewer.html?ra=..&dec=..&fov=..&det=..&mode=..&embed=1
function viewerUrl({ ra, dec, fov = 0.25, name, ...extra }) {
  const q = new URLSearchParams({ ra: (+ra).toFixed(5), dec: (+dec).toFixed(5), fov: +(+fov).toFixed(4) });
  if (name) q.set('name', name);
  for (const [k, v] of Object.entries(extra)) if (v != null && v !== '') q.set(k, v);
  return `viewer.html?${q}`;
}

// ---------- coordinate parsing ----------

function parseAngle(text) {
  const t = String(text).trim().replace('−', '-');   // accept a typographic minus
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
  const isHours = /[h:]/i.test(text) || p.count > 1;   // "08h55m..." or "08 55 10" means hours
  const deg = isHours ? p.value * 15 : p.value;
  return deg >= 0 && deg < 360 ? deg : null;
}

function parseDec(text) {
  const p = parseAngle(text);
  if (!p) return null;
  const deg = p.negative ? -p.value : p.value;
  return deg >= -90 && deg <= 90 ? deg : null;
}

// ---------- placeholder art ----------

// Draws a made-up star field, the same every time for the same seed. Used for
// gallery cards that don't have a real thumbnail yet, and for page backgrounds.
function drawStarfield(canvas, seed = 1, { density = 1, tint = '#7cc4ff' } = {}) {
  let s = 0;
  for (const ch of String(seed)) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  const g = ctx.createRadialGradient(w * rand(), h * rand(), 0, w / 2, h / 2, Math.max(w, h));
  g.addColorStop(0, tint + '33');
  g.addColorStop(1, '#000000');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const n = Math.round((w * h) / 900 * density);
  for (let i = 0; i < n; i++) {
    const r = rand() ** 6 * 2.4 + 0.4;
    ctx.globalAlpha = 0.35 + rand() * 0.65;
    ctx.fillStyle = rand() > 0.85 ? '#ffd9a0' : '#e8f0ff';
    ctx.beginPath();
    ctx.arc(rand() * w, rand() * h, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
