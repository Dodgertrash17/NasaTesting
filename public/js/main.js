const state = {
  patches: [],      // the list from data/patches.json (M6)
  patch: null,      // the open patch's handshake file, e.g. data/m101.json
  frame: 0,         // which date is showing
  playing: false,   // is the blink running?
  revealed: false,  // has the answer been shown?
  timer: null,
};

let images = []

const els = {
  hook:      document.querySelector('#hook'),
  start:     document.querySelector('#start'),
  challenge: document.querySelector('#challenge'),
  canvas:    document.querySelector('#sky'),
  blink:     document.querySelector('#blink'),
  frame:     document.querySelector('#frame'),
  frameDate: document.querySelector('#frame-date'),
  reveal:    document.querySelector('#reveal'),
  status:    document.querySelector('#status'),
};

function currentPatch() {
  return state.patch;
}

// The handshake file gives times as MJD (days since 1858-11-17). 40587 is 1970-01-01.
function mjdToDate(mjd) {
  return new Date((mjd - 40587) * 86400000).toISOString().slice(0, 10);   // "2025-05-01"
}

function setStatus(text) {
  els.status.textContent = text;   // role="status" reads it aloud politely
}

async function loadJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

function render() {
  const patch = currentPatch();
  const frame = patch.frames[state.frame];
  drawFrame(images[state.frame]);                        // M7
  if (state.revealed) drawCandidates(patch, state.frame); // M8
  els.frame.max = patch.frames.length - 1;
  els.frame.value = state.frame;
  els.frameDate.textContent = mjdToDate(frame.mjd);
  els.blink.setAttribute('aria-pressed', String(state.playing));
  els.blink.textContent = state.playing ? 'Pause' : 'Blink';
}

async function loadImage(src) {
  const img = new Image();
  img.src = src;
  await img.decode();     // waits until the image is ready to paint, returns a 'Promise'
  return img;
}

async function loadPatchImages(patch, jsonUrl) {
  images = await Promise.all(
    patch.frames.map(f => loadImage(new URL(f.file, jsonUrl)))
  );
}

function drawFrame(img) {
  const ctx = els.canvas.getContext('2d');
  els.canvas.width = img.naturalWidth;     // 1 canvas pixel = 1 image pixel
  els.canvas.height = img.naturalHeight;
  ctx.imageSmoothingEnabled = false;       // keep real pixels when scaled
  ctx.drawImage(img, 0, 0);
}

async function openPatch(id) {
  setStatus('Loading sky images…');
  try {
    const jsonUrl = new URL(`data/${id}.json`, location.href);
    const patch = await loadJSON(jsonUrl);
    await loadPatchImages(patch, jsonUrl);      // preload before the first blink
    Object.assign(state, { patch, frame: 0, revealed: false });
    setStatus('');
    render();
  } catch (err) {
    console.error(err);
    setStatus('We could not load the sky images. Check your connection and reload the page.');
  }
}

const SPEED_MS = { slow: 1000, normal: 500, fast: 250 } // ms

function startBlink(speed = 'normal') {
  clearInterval(state.timer);          // never run two timers at once
  state.playing = true;
  state.timer = setInterval(() => {
    state.frame = (state.frame + 1) % currentPatch().frames.length;
    render();
  }, SPEED_MS[speed]);
  render();
}

function stopBlink() {
  clearInterval(state.timer);
  state.playing = false;
  render();
}


els.frame.addEventListener('input', () => {
  stopBlink();
  state.frame = Number(els.frame.value);
  render();
});

els.start.addEventListener('click', () => {
  els.hook.hidden = true;
  els.challenge.hidden = false;
});

els.blink.addEventListener('click', () => {
  state.playing ? stopBlink() : startBlink();
});

els.canvas.addEventListener('keydown', (e) => {
  const last = currentPatch().frames.length - 1;
  if (e.key === ' ') {
    e.preventDefault();                // stop the page scrolling
    state.playing ? stopBlink() : startBlink();
  }
  if (e.key === 'ArrowRight') { stopBlink(); state.frame = Math.min(state.frame + 1, last); render(); }
  if (e.key === 'ArrowLeft')  { stopBlink(); state.frame = Math.max(state.frame - 1, 0);    render(); }
});

async function start() {
  try {
    state.patches = await loadJSON('data/patches.json');
  } catch (err) {
    state.patches = [{ id: 'm101', title: 'Practice patch' }];   // fallback until Pipe writes the list
  }
  await openPatch(state.patches[0].id);
}

start()