// Home page: a background star field and a small blinking example.

(function background() {
  const c = document.querySelector('#home-sky');
  const draw = () => {
    c.width = innerWidth; c.height = innerHeight;
    drawStarfield(c, 'home', { density: 0.5, tint: '#1c3a7a' });
  };
  draw();
  addEventListener('resize', draw);
})();

(async function heroBlink() {
  const canvas = document.querySelector('#hero-canvas');
  const label = document.querySelector('#hero-date');
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  let patch, imgs;
  try {
    patch = await loadJSON('data/demo.json');
    imgs = await Promise.all(patch.frames.map(f => loadImage('data/' + f.file)));
  } catch {
    drawStarfield(canvas, 'hero');      // no demo data: still show something pretty
    return;
  }
  let i = 0, timer = null;
  const button = document.querySelector('#hero-play');
  const show = () => {
    ctx.drawImage(imgs[i], 0, 0, canvas.width, canvas.height);   // instant swap, no fade
    label.textContent = mjdToDate(patch.frames[i].mjd);
  };
  // Never autoplay (WCAG 2.2.2): the visitor starts it, and the same button pauses it.
  // 700 ms per swap is well under the 3-flashes-a-second limit (WCAG 2.3.1).
  const toggle = () => {
    if (timer) { clearInterval(timer); timer = null; }
    else timer = setInterval(() => { i = (i + 1) % imgs.length; show(); }, 700);
    button.setAttribute('aria-pressed', String(!!timer));
    button.textContent = timer ? '❚❚ Pause' : '▶ Blink';
  };
  button.addEventListener('click', toggle);
  show();
})();
