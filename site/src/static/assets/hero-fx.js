// Hero cards (every page): the frosted cards follow the pointer with an eased parallax (a different depth each), keep a slow idle
// float of a few pixels, and tilt toward the pointer with a light glow when hovered. Touch and no-hover devices get the float
// only. Everything here is "full motion": when html[data-motion] is "reduced" (see motion.js) nothing moves and the cards are
// left to the CSS, which still highlights border, glow and sheen. The loop, and the CSS arcs (through .is-paused), run only
// while the hero is on screen and the tab is visible. Transform and custom properties only; no layout, no libraries.
(() => {
  const box = document.querySelector('.hero-cards');
  if (!box) return;
  const root = document.documentElement;
  const hero = box.closest('.hero');
  const hover = matchMedia('(hover: hover) and (pointer: fine)');
  const full = () => root.dataset.motion === 'full';
  const cards = [...box.querySelectorAll('.gcard')].map((el, i) => ({
    el, d: Number(el.dataset.d) || 1, ph: i * 1.9 + 0.6, sp: 0.42 + (i % 3) * 0.11, amp: 3 + (i % 2) * 2.5,
    hx: 0, hy: 0, hs: 0, tx: 0, ty: 0, ts: 0, // hover tilt: current and target
  }));
  const tgt = { x: 0, y: 0 }, cur = { x: 0, y: 0 };
  let running = false, visible = true, last = 0, t = 0;

  const paint = (dt) => {
    const k = 1 - Math.exp(-dt * 4.5), kh = 1 - Math.exp(-dt * 9);
    cur.x += (tgt.x - cur.x) * k; cur.y += (tgt.y - cur.y) * k;
    for (const c of cards) {
      c.hx += (c.tx - c.hx) * kh; c.hy += (c.ty - c.hy) * kh; c.hs += (c.ts - c.hs) * kh;
      const x = cur.x * 22 * c.d + Math.sin(t * c.sp + c.ph) * c.amp * 0.6;
      const y = cur.y * 18 * c.d + Math.cos(t * c.sp * 1.15 + c.ph) * c.amp;
      const tilt = Math.abs(c.hx) + Math.abs(c.hy) + c.hs > 0.001 ? ` perspective(800px) rotateX(${(c.hy * -7).toFixed(2)}deg) rotateY(${(c.hx * 9).toFixed(2)}deg) scale(${(1 + c.hs * 0.035).toFixed(4)})` : '';
      c.el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)${tilt}`;
    }
  };
  const loop = (now) => {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now; t += dt; paint(dt);
    requestAnimationFrame(loop);
  };
  const clear = () => {
    tgt.x = tgt.y = cur.x = cur.y = 0;
    for (const c of cards) { c.hx = c.hy = c.hs = c.tx = c.ty = c.ts = 0; c.el.style.transform = ''; c.el.style.removeProperty('--mx'); c.el.style.removeProperty('--my'); }
  };
  const sync = () => {
    const shown = visible && !document.hidden;
    hero.classList.toggle('is-paused', !shown);
    const on = shown && full();
    if (on && !running) { running = true; last = performance.now(); requestAnimationFrame(loop); }
    if (!on) { running = false; if (!full()) clear(); }
  };

  new IntersectionObserver(([e]) => { visible = e.isIntersecting; sync(); }).observe(hero);
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('motionchange', sync);

  addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' || !hover.matches || !full()) return;
    const b = hero.getBoundingClientRect();
    tgt.x = Math.max(-1, Math.min(1, (e.clientX - b.left) / b.width * 2 - 1));
    tgt.y = Math.max(-1, Math.min(1, (e.clientY - b.top) / Math.min(b.height, 900) * 2 - 1));
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { tgt.x = tgt.y = 0; });

  for (const c of cards) {
    c.el.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch' || !hover.matches || !full()) return;
      const r = c.el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
      c.el.style.setProperty('--mx', `${(px * 100).toFixed(1)}%`);
      c.el.style.setProperty('--my', `${(py * 100).toFixed(1)}%`);
      c.tx = (px - 0.5) * 2; c.ty = (py - 0.5) * 2; c.ts = 1;
    });
    c.el.addEventListener('pointerleave', () => { c.tx = c.ty = c.ts = 0; });
  }
  sync();
})();
