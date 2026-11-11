// Search Tool: three tabs (raw coordinates, gallery, filtered). Every path ends at viewer.html.

const TYPE_LABEL = {
  'brown-dwarf': 'Brown dwarf', star: 'Nearby star', variable: 'Variable star',
  nebula: 'Nebula', asteroid: 'Asteroid', demo: 'Demo',
};
const STATUS = {
  ready:   { text: 'Images ready', cls: 'pill-ok' },
  demo:    { text: 'Demo images', cls: 'pill-warn' },
  pending: { text: 'Data due Nov 13', cls: '' },
};

// ---------- tabs ----------

const tabs = [...document.querySelectorAll('[role="tab"]')];

function selectTab(name, { focus = false } = {}) {
  for (const t of tabs) {
    const on = t.id === `tab-${name}`;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    if (on && focus) t.focus();
  }
  history.replaceState(null, '', `#${name}`);
}

for (const t of tabs) {
  t.addEventListener('click', () => selectTab(t.id.slice(4)));
  t.addEventListener('keydown', (e) => {       // arrow keys move between tabs
    const i = tabs.indexOf(t);
    const j = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
    if (j === null) return;
    selectTab(tabs[(j + tabs.length) % tabs.length].id.slice(4), { focus: true });
  });
}
addEventListener('hashchange', () => {
  const name = location.hash.slice(1);
  if (tabs.some(t => t.id === `tab-${name}`)) selectTab(name);
});

// ---------- raw search ----------

const form = document.querySelector('#coord-form');
const raInput = document.querySelector('#ra');
const decInput = document.querySelector('#dec');
const fovInput = document.querySelector('#fov');
const formError = document.querySelector('#form-error');

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const ra = parseRA(raInput.value);
  const dec = parseDec(decInput.value);
  raInput.setAttribute('aria-invalid', String(ra === null));
  decInput.setAttribute('aria-invalid', String(dec === null));
  if (ra === null || dec === null) {
    formError.textContent = ra === null
      ? 'Right Ascension should look like 133.795 (degrees) or 08h55m10s (hours).'
      : 'Declination should be between −90 and +90, like -7.245 or -7d14m42s.';
    (ra === null ? raInput : decInput).focus();
    return;
  }
  formError.textContent = '';
  const named = knownTarget(ra, dec);
  const url = viewerUrl({ ra, dec, fov: fovInput.value, name: named?.name });
  location.href = e.submitter?.value === 'dome' ? url.replace('viewer.html', 'dome.html') : url;
});

fovInput.replaceChildren(...FOV_OPTIONS.map(o => new Option(o.label, o.deg)));
fovInput.value = String(15 / 60);

// One click opens the viewer with the field of view that suits each target.
document.querySelector('#presets').replaceChildren(...TARGETS.map(t => {
  const a = document.createElement('a');
  a.className = 'btn preset';
  a.href = viewerUrl({ ra: t.ra, dec: t.dec, fov: t.fov, name: t.name });
  a.innerHTML = `<span></span><span class="preset-kind">${t.kind === 'mover' ? 'moves' : 'varies'}</span>`;
  a.firstChild.textContent = t.name;
  return a;
}));

// ---------- gallery cards (used by Gallery and Filtered) ----------

function card(item) {
  const a = document.createElement('a');
  a.className = 'g-card';
  a.href = viewerUrl(item);
  const st = STATUS[item.status] || STATUS.pending;

  const thumb = document.createElement('div');
  thumb.className = 'g-thumb';
  if (item.thumb) {
    const img = document.createElement('img');
    img.src = item.thumb; img.alt = ''; img.loading = 'lazy';
    thumb.append(img);
  } else {
    const c = document.createElement('canvas');     // placeholder until real thumbnails exist
    c.width = 320; c.height = 240;
    drawStarfield(c, item.id);
    thumb.append(c);
  }
  thumb.insertAdjacentHTML('beforeend', `<span class="pill ${st.cls}">${st.text}</span>`);

  const body = document.createElement('div');
  body.className = 'g-body';
  body.innerHTML = `
    <h3></h3>
    <p></p>
    <div class="g-meta"><span>${TYPE_LABEL[item.type] || item.type}</span>
      <span class="mono">${formatRA(item.ra).slice(0, 9)} ${formatDec(item.dec).slice(0, 7)}</span></div>`;
  body.querySelector('h3').textContent = item.name;
  body.querySelector('p').textContent = item.blurb;
  a.append(thumb, body);
  return a;
}

// ---------- filtered (prototype) ----------

let items = [];
const filterForm = document.querySelector('#filter-form');

function applyFilters() {
  const f = new FormData(filterForm);
  const types = new Set(f.getAll('type'));
  const hasData = f.has('hasData');
  const hemi = f.get('hemisphere');
  const out = items.filter(i =>
    types.has(i.type) &&
    (!hasData || i.status === 'ready' || i.status === 'demo') &&
    (hemi === 'any' || (hemi === 'north' ? i.dec > 0 : i.dec < 0)));
  document.querySelector('#results-count').textContent =
    `${out.length} of ${items.length} targets match`;
  document.querySelector('#filtered-results').replaceChildren(...out.map(card));
}
filterForm.addEventListener('change', applyFilters);

// ---------- start ----------

(async function start() {
  const first = location.hash.slice(1);
  selectTab(tabs.some(t => t.id === `tab-${first}`) ? first : 'raw');
  try {
    items = await loadJSON('data/gallery.json');
  } catch {
    items = TARGETS.map(t => ({ ...t, type: 'star', status: 'pending', blurb: '' }));
  }
  document.querySelector('#gallery').replaceChildren(...items.map(card));
  applyFilters();
})();
