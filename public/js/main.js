const state = {
  patches: [],      // the list from data/patches.json (M6)
  patch: null,      // the open patch's handshake file, e.g. data/m101.json
  frame: 0,         // which date is showing
  playing: false,   // is the blink running?
  revealed: false,  // has the answer been shown?
  timer: null,
};

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

function drawFrame() {

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

els.frame.addEventListener('input', () => {
  stopBlink();
  state.frame = Number(els.frame.value);
  render();
});

els.start.addEventListener('click', () => {
  els.hook.hidden = true;
  els.challenge.hidden = false;
});