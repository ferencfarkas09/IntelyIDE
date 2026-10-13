// Google Analytics 4, loaded only after the visitor accepts (GDPR / ePrivacy). Progressive enhancement:
// without this file, or without consent, no Google script is loaded and nothing is sent.
(function (w) {
  'use strict';
  // Measurement ids: the first one loads gtag.js; every one gets its own config, so each stream receives the page views and events.
  var IDS = ['G-E7RB55MV0F', 'G-NY3S7X9J5P'];
  var ID = IDS[0];
  var KEY = 'ga-consent';
  var doc = w.document;
  var loaded = false;
  var EVENTS = { download: 'download_click', nav: 'nav_click', cta: 'cta_click', lang: 'language_switch', theme: 'theme_toggle' };

  w.dataLayer = w.dataLayer || [];
  function gtag() { w.dataLayer.push(arguments); }

  function read() { try { return w.localStorage.getItem(KEY); } catch (e) { return null; } }
  function write(v) { try { w.localStorage.setItem(KEY, v); } catch (e) { /* storage blocked: choice lasts for this page only */ } }

  function load() {
    if (loaded) return;
    loaded = true;
    IDS.forEach(function (id) { w['ga-disable-' + id] = false; });
    // Advertising signals stay denied always; only measurement is granted, and only by the visitor's choice.
    gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied' });
    gtag('consent', 'update', { analytics_storage: 'granted' });
    gtag('js', new Date());
    IDS.forEach(function (id) { gtag('config', id, { allow_google_signals: false, allow_ad_personalization_signals: false }); });
    var s = doc.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + ID;
    doc.head.appendChild(s);
  }

  function clearCookies() {
    var host = w.location.hostname;
    var parts = host.split('.');
    var domains = ['', host, '.' + host];
    if (parts.length > 2) domains.push('.' + parts.slice(-2).join('.'));
    doc.cookie.split(';').forEach(function (c) {
      var name = c.split('=')[0].trim();
      if (name !== '_ga' && name.indexOf('_ga_') !== 0 && name !== '_gid') return;
      domains.forEach(function (d) {
        doc.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/' + (d ? '; domain=' + d : '');
      });
    });
  }

  function withdraw() {
    IDS.forEach(function (id) { w['ga-disable-' + id] = true; });
    if (loaded) gtag('consent', 'update', { analytics_storage: 'denied' });
    clearCookies();
  }

  var banner = doc.getElementById('consent');
  function show(focus) {
    if (!banner) return;
    banner.hidden = false;
    if (focus) { var b = banner.querySelector('[data-consent="granted"]'); if (b) b.focus(); }
  }
  function choose(v) {
    write(v);
    if (banner) banner.hidden = true;
    if (v === 'granted') load(); else withdraw();
  }

  function track(el) {
    if (!loaded || w['ga-disable-' + ID]) return;
    var kind = el.getAttribute('data-ga');
    var name = EVENTS[kind];
    if (!name) return;
    var label = el.getAttribute('data-ga-label') || '';
    var lang = doc.documentElement.lang || '';
    var params = { link_location: label, language: lang, transport_type: 'beacon' };
    if (kind === 'download') {
      var href = el.getAttribute('href') || '';
      var fileName = href.split('#')[0].split('?')[0].split('/').pop() || '';
      try {
        fileName = decodeURIComponent(fileName);
      } catch (e) {
        // a malformed escape: keep the raw name
      }
      params.file_name = fileName;
      var platform = el.getAttribute('data-ga-platform');
      if (platform) params.platform = platform;
      params.version = (doc.body && doc.body.getAttribute('data-version')) || '';
    } else if (kind === 'lang') {
      params.language = label;
    } else if (kind === 'theme') {
      params.theme = doc.documentElement.dataset.theme || '';
    }
    gtag('event', name, params);
  }

  doc.addEventListener('click', function (e) {
    var t = e.target;
    var open = t.closest && t.closest('[data-consent-open]');
    if (open) { show(true); return; }
    var pick = t.closest && t.closest('[data-consent]');
    if (pick) { choose(pick.getAttribute('data-consent')); return; }
    var el = t.closest && t.closest('[data-ga]');
    if (el) track(el);
  });

  var saved = read();
  if (saved === 'granted') load();
  else if (saved !== 'denied') show(false);
})(window);
