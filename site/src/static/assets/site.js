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
    document.querySelectorAll('[data-theme-set]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === effective())));
  }
  function setTheme(value) {
    root.dataset.theme = value;
    try { localStorage.setItem('theme', value); } catch { /* storage unavailable: keep for this visit */ }
    applyTheme();
  }
  applyTheme();
  dark.addEventListener('change', applyTheme);
  document.getElementById('theme-toggle')?.addEventListener('click', () => setTheme(effective() === 'dark' ? 'light' : 'dark'));
  // The showcase switch drives the same site theme, so the pictures and the page always agree.
  document.querySelectorAll('[data-theme-set]').forEach((b) => b.addEventListener('click', () => setTheme(b.dataset.themeSet)));

  // Mobile menu.
  const menu = document.querySelector('.menu-btn');
  const nav = document.getElementById('site-nav');
  menu?.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    menu.setAttribute('aria-expanded', String(open));
  });
  nav?.addEventListener('click', (e) => {
    if (e.target.closest('a')) { nav.classList.remove('open'); menu?.setAttribute('aria-expanded', 'false'); closeSub(); }
  });

  // Products dropdown: a button that toggles the list. Escape and a click outside close it; no inline JS.
  const sub = document.querySelector('.has-sub');
  const subBtn = sub?.querySelector('.sub-btn');
  function closeSub(restoreFocus) {
    if (!sub?.classList.contains('open')) return;
    sub.classList.remove('open');
    subBtn.setAttribute('aria-expanded', 'false');
    if (restoreFocus) subBtn.focus();
  }
  subBtn?.addEventListener('click', () => {
    const open = sub.classList.toggle('open');
    subBtn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => { if (sub && !sub.contains(e.target)) closeSub(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (sub?.classList.contains('open')) closeSub(true);
    else if (nav?.classList.contains('open')) { nav.classList.remove('open'); menu?.setAttribute('aria-expanded', 'false'); menu?.focus(); }
  });
  sub?.addEventListener('focusout', (e) => { if (!sub.contains(e.relatedTarget)) closeSub(); });

  // Old IntelyIDE links such as /#install or /hu/#trust now live on the product page: forward them.
  const ideUrl = document.body.dataset.ideUrl;
  const hash = decodeURIComponent(location.hash.slice(1));
  if (ideUrl && hash && !document.getElementById(hash)) location.replace(`${ideUrl}#${hash}`);

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

  // With files for several platforms: point the big button at the visitor's own file. Apple Silicon or Intel does not matter (universal
  // macOS app). Unknown systems (phones, tablets, ChromeOS) keep the link to the release page.
  function detectPlatform() {
    const ua = navigator.userAgent || '';
    const hint = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    if (/android|iphone|ipad|ipod|cros/i.test(ua) || /android|ios|chrome os/i.test(hint)) return null;
    if (/mac/i.test(hint) || /Macintosh|Mac OS X/.test(ua)) return navigator.maxTouchPoints > 1 ? null : 'mac'; // iPadOS reports a Mac with touch
    if (/win/i.test(hint) || /Windows/.test(ua)) return 'windows';
    if (/linux|x11/i.test(hint) || /Linux|X11/.test(ua)) return 'linux';
    return null;
  }
  const platform = detectPlatform();
  document.querySelectorAll('[data-dl-multi]').forEach((block) => {
    const btn = block.querySelector('.dl-btn');
    const link = platform && block.querySelector('.dl-other a[data-primary][data-platform="' + platform + '"]');
    if (!btn || !link) return;
    btn.setAttribute('href', link.getAttribute('href'));
    btn.dataset.gaPlatform = platform;
    btn.querySelector('.dl-main').textContent = link.dataset.label;
    btn.querySelector('.dl-sub').textContent = link.dataset.sub;
    block.querySelectorAll('[data-note]').forEach((n) => n.classList.toggle('is-current', n.dataset.note === platform));
  });

  // Files for macOS only: a Windows or Linux visitor sees the note and the button opens the release page instead of a macOS file.
  if (platform === 'windows' || platform === 'linux') {
    document.querySelectorAll('[data-mac-only]').forEach((block) => {
      const btn = block.querySelector('.dl-btn');
      const note = block.querySelector('[data-soon]');
      if (!btn || !note) return;
      note.hidden = false;
      btn.setAttribute('href', block.dataset.soonHref);
      btn.dataset.gaPlatform = platform;
      btn.querySelector('.dl-main').textContent = block.dataset.soonLabel;
    });
  }

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
