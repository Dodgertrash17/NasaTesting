// Sky Dome: SKELETON ONLY. Placeholder background, a sub-nav that hides when the
// mouse is idle, and a link back to the viewer. The real all-sky view is not built yet.

const dome = document.querySelector('#dome');
const sky = document.querySelector('#dome-sky');

function drawSky() {
  sky.width = dome.clientWidth;
  sky.height = dome.clientHeight;
  drawStarfield(sky, 'dome', { density: 0.9, tint: '#2a4a9a' });
}
drawSky();
addEventListener('resize', drawSky);

// If we came from the viewer (dome.html?ra=..&dec=..), offer the way back.
const q = new URLSearchParams(location.search);
if (q.has('ra') && q.has('dec')) {
  const back = document.querySelector('#back-to-viewer');
  back.href = 'viewer.html' + location.search;
  back.hidden = false;
  if (q.get('name')) document.querySelector('#dome-target').textContent =
    `You came from ${q.get('name')}. The dome will open centered on it.`;
}

// Toolbar fades after 2.5 s without mouse movement, and comes back on movement.
let idleTimer;
function wake() {
  dome.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => dome.classList.add('idle'), 2500);
}
for (const ev of ['mousemove', 'keydown', 'touchstart', 'focusin']) dome.addEventListener(ev, wake);
wake();

// TODO(dome): replace the placeholder canvas with an all-sky renderer.
//  - Aladin Lite (CDS) can show HiPS sky surveys and catalog markers in a browser.
//  - WorldWide Telescope's web client shows the "standing in a field" view.
//  - Points of interest: load from data/gallery.json (ra, dec, size by brightness).
