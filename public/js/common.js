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

// Challenge targets (J2000). Shared by the search page and the viewer.
const TARGETS = [
  { id: 'wise0855', name: 'WISE 0855',      ra: 133.7951, dec: -7.2451 },
  { id: 'barnard',  name: "Barnard's Star", ra: 269.4521, dec: 4.6934 },
  { id: 'epsindib', name: 'Epsilon Indi B', ra: 331.0438, dec: -56.7827 },
  { id: 'rwaur',    name: 'RW Aurigae',     ra: 76.9563,  dec: 30.4013 },
  { id: 'rdra',     name: 'R Draconis',     ra: 248.1675, dec: 66.7551 },
];

// ---------- header + footer ----------

function renderChrome() {
  const page = document.body.dataset.page;
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

function viewerUrl({ ra, dec, fov = 0.25, name }) {
  const q = new URLSearchParams({ ra: (+ra).toFixed(5), dec: (+dec).toFixed(5), fov });
  if (name) q.set('name', name);
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
