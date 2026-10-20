// Motion mode for the whole site: html[data-motion] is "full" or "reduced". It follows the system setting
// (prefers-reduced-motion) unless the visitor chose otherwise with the footer toggle; the choice is kept in localStorage
// (every access is guarded, the site works without it). hero-fx.js and style.css read the attribute.
(() => {
  const root = document.documentElement;
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  const KEY = 'intely-animations';
  const read = () => { try { const v = localStorage.getItem(KEY); return v === 'on' || v === 'off' ? v : null; } catch { return null; } };
  const write = (v) => { try { localStorage.setItem(KEY, v); } catch { /* private mode: the choice lasts for this page only */ } };
  const mode = () => { const c = read(); return c === 'on' ? 'full' : c === 'off' ? 'reduced' : mq.matches ? 'reduced' : 'full'; };

  function paint() {
    const full = root.dataset.motion === 'full';
    for (const b of document.querySelectorAll('[data-motion-toggle]')) {
      b.textContent = `${b.dataset.label}: ${full ? b.dataset.on : b.dataset.off}`;
      b.setAttribute('aria-pressed', String(full));
    }
    for (const h of document.querySelectorAll('[data-motion-hint]')) h.hidden = !mq.matches;
  }
  function apply() {
    const m = mode();
    if (root.dataset.motion !== m) { root.dataset.motion = m; window.dispatchEvent(new Event('motionchange')); }
    paint();
  }
  apply();
  mq.addEventListener('change', apply);
  document.addEventListener('DOMContentLoaded', paint);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-motion-toggle]')) return;
    write(root.dataset.motion === 'full' ? 'off' : 'on');
    apply();
  });
})();
