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
  let i = 0;
  const show = () => {
    ctx.drawImage(imgs[i], 0, 0, canvas.width, canvas.height);
    label.textContent = mjdToDate(patch.frames[i].mjd);
  };
  show();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  setInterval(() => { i = (i + 1) % imgs.length; show(); }, 700);
})();
