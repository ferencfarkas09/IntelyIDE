// Hero background: faint glass bubbles that drift and gently move away from the cursor, soft glows that
// parallax with it, and a glow that trails the pointer. Decorative only (the container is aria-hidden).
// Without this file the page shows the static CSS glows; with prefers-reduced-motion the bubbles are placed once.
(() => {
  const bg = document.querySelector('.hero-bg');
  if (!bg) return;
  const hero = bg.parentElement;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const trail = bg.querySelector('.cursor-glow');
  const COLORS = ['#2ee6c5', '#7c4dff', '#d946ef', '#2b6cf6', '#ff9a1f'];

  let seed = 11; // fixed seed: the same layout on every load
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  const bubbles = Array.from({ length: 12 }, (_, i) => {
    const r = 12 + rnd() ** 2 * 54;
    const el = document.createElement('span');
    el.className = 'bubble';
    el.style.width = el.style.height = `${r * 2}px`;
    el.style.setProperty('--c', COLORS[i % COLORS.length]);
    bg.appendChild(el);
    return {
      el, r, depth: 0.3 + rnd() * 0.7,
      bx: 0.04 + rnd() * 0.92, by: 0.06 + rnd() * 0.78,
      ph: rnd() * 6.283, sx: 0.1 + rnd() * 0.16, sy: 0.08 + rnd() * 0.14,
      ax: 14 + rnd() * 26, ay: 12 + rnd() * 24, ox: 0, oy: 0, sc: 1,
    };
  });

  let W = 0, H = 0; // H = height of the area the bubbles use: the top of the hero, not the screenshot below it
  const cur = { x: 0, y: 0 };   // smoothed pointer, hero-local px
  const tgt = { x: 0, y: 0 };   // raw pointer
  let active = false, running = false, last = 0, t = 0;

  const measure = () => {
    const b = hero.getBoundingClientRect();
    if (!cur.x && !cur.y) { cur.x = tgt.x = b.width / 2; cur.y = tgt.y = b.height * 0.4; }
    W = b.width; H = Math.min(b.height, 780);
  };

  function place(dt) {
    const k = 1 - Math.exp(-dt * 5);
    cur.x += (tgt.x - cur.x) * k;
    cur.y += (tgt.y - cur.y) * k;
    bg.style.setProperty('--px', (((cur.x / W) - 0.5) * 2).toFixed(3));
    bg.style.setProperty('--py', (((cur.y / H) - 0.5) * 2).toFixed(3));
    if (trail) trail.style.transform = `translate3d(${cur.x.toFixed(1)}px, ${cur.y.toFixed(1)}px, 0)`;
    const ease = 1 - Math.exp(-dt * 4);
    for (const b of bubbles) {
      const ix = b.bx * W + Math.sin(t * b.sx + b.ph) * b.ax + ((cur.x / W) - 0.5) * b.depth * 36;
      const iy = b.by * H + Math.cos(t * b.sy + b.ph * 1.3) * b.ay + ((cur.y / H) - 0.5) * b.depth * 28;
      let tx = 0, ty = 0, near = 0;
      if (active) {
        const dx = ix - tgt.x, dy = iy - tgt.y, d = Math.hypot(dx, dy) || 1, reach = 170 + b.r;
        if (d < reach) { near = (1 - d / reach) ** 2; tx = (dx / d) * near * 90 * (0.5 + b.depth); ty = (dy / d) * near * 90 * (0.5 + b.depth); }
      }
      b.ox += (tx - b.ox) * ease; b.oy += (ty - b.oy) * ease;
      b.sc += ((1 + near * 0.18) - b.sc) * ease;
      b.el.style.transform = `translate3d(${(ix + b.ox - b.r).toFixed(1)}px, ${(iy + b.oy - b.r).toFixed(1)}px, 0) scale(${b.sc.toFixed(3)})`;
    }
  }

  function loop(now) {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now; t += dt;
    place(dt);
    requestAnimationFrame(loop);
  }
  const start = () => { if (running || reduce.matches) return; running = true; last = performance.now(); requestAnimationFrame(loop); };
  const stop = () => { running = false; };

  measure();
  place(1);
  bg.classList.add('is-live');
  new ResizeObserver(() => { measure(); if (!running) place(1); }).observe(hero);
  new IntersectionObserver(([e]) => (e.isIntersecting ? start() : stop())).observe(hero);
  reduce.addEventListener('change', () => (reduce.matches ? stop() : start()));

  addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' || reduce.matches) return;
    const b = hero.getBoundingClientRect();
    const x = e.clientX - b.left, y = e.clientY - b.top;
    active = x > -60 && x < b.width + 60 && y > -60 && y < b.height + 60;
    if (active) { tgt.x = x; tgt.y = y; }
    trail?.classList.toggle('on', active);
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => {
    active = false; trail?.classList.remove('on');
    tgt.x = W / 2; tgt.y = H * 0.4;
  });
})();
