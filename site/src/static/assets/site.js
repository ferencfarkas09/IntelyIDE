// Progressive enhancement only. The page and the download link work without this file.
(() => {
  const root = document.documentElement;
  const dark = matchMedia('(prefers-color-scheme: dark)');

  // Theme: <picture> dark sources follow the manual toggle, not just the OS setting.
  const effective = () => root.dataset.theme || (dark.matches ? 'dark' : 'light');
  function applyTheme() {
    const forced = root.dataset.theme;
    const media = forced === 'dark' ? 'all' : forced === 'light' ? 'not all' : '(prefers-color-scheme: dark)';
    document.querySelectorAll('source[data-theme="dark"]').forEach((s) => (s.media = media));
    const toggle = document.getElementById('theme-toggle');
    if (toggle) toggle.setAttribute('aria-pressed', String(effective() === 'dark'));
  }
  applyTheme();
  dark.addEventListener('change', applyTheme);
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    root.dataset.theme = effective() === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('theme', root.dataset.theme); } catch { /* storage unavailable: keep for this visit */ }
    applyTheme();
  });

  // Mobile menu.
  const menu = document.querySelector('.menu-btn');
  const nav = document.getElementById('site-nav');
  menu?.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    menu.setAttribute('aria-expanded', String(open));
  });
  nav?.addEventListener('click', (e) => {
    if (e.target.closest('a')) { nav.classList.remove('open'); menu?.setAttribute('aria-expanded', 'false'); }
  });

  // Sticky header download button, shown once the hero button has scrolled away.
  const hdr = document.querySelector('.hdr-dl');
  const heroBtn = document.getElementById('hero-dl');
  if (hdr && heroBtn && 'IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => hdr.classList.toggle('is-on', !e.isIntersecting && e.boundingClientRect.top < 0)).observe(heroBtn);
  }

  // Copy SHA-256.
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    const label = btn.textContent;
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        btn.textContent = btn.dataset.done;
        setTimeout(() => (btn.textContent = label), 1800);
      } catch { /* clipboard blocked: the checksum stays selectable */ }
    });
  });

  // Offer the matching build when both Intel and Apple Silicon exist and the browser reveals the CPU.
  const block = document.querySelector('[data-dl-block][data-swap]');
  navigator.userAgentData?.getHighEntropyValues?.(['architecture']).then(({ architecture }) => {
    const btn = block?.querySelector('.dl-btn');
    const alt = block?.querySelector('.dl-alt');
    const want = architecture === 'arm' ? 'arm64' : 'x64';
    if (!btn || !alt || btn.dataset.arch === want || alt.dataset.arch !== want) return;
    for (const k of ['href', 'arch', 'sub', 'alt']) {
      const a = k === 'href' ? btn.getAttribute(k) : btn.dataset[k];
      const b = k === 'href' ? alt.getAttribute(k) : alt.dataset[k];
      if (k === 'href') { btn.setAttribute(k, b); alt.setAttribute(k, a); } else { btn.dataset[k] = b; alt.dataset[k] = a; }
    }
    btn.querySelector('.dl-sub').textContent = btn.dataset.sub;
    alt.textContent = alt.dataset.alt;
  }).catch(() => {});
})();
