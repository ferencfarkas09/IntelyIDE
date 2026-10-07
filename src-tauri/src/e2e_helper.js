// e2e helpers, injected before the scenario script (see e2e.rs). Screenshots are named <scenario>-<name>-<theme>.png.
// The scenarios match English labels: pin the UI language (it would follow the machine's language, Hungarian here) before the app reads it.
try { if (!localStorage.getItem("intely.locale")) localStorage.setItem("intely.locale", "en"); } catch { /* no storage: the app falls back to the browser language */ }
window.__e2e = {
  /** True on a page load the scenario asked for (`reloadInto` / `expectReload` in lib.js), false on the first one. */
  reloaded: false,
  scenario: window.__e2e_scenario || "e2e",
  theme: () => document.documentElement.getAttribute("data-theme") || "unknown",
  /** Waits for two painted frames (never on rAF alone: it does not fire in an occluded window), then saves the snapshot. */
  async screenshot(name, scale = 2) {
    await new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(() => r())); setTimeout(r, 120); });
    const stem = `${this.scenario}-${name}-${this.theme()}`;
    return window.__TAURI_INTERNALS__.invoke("e2e_screenshot", { stem, scale });
  },
  /** Sets the window's inner size in logical pixels and waits until the page reports it. */
  async resize(width, height) {
    await window.__TAURI_INTERNALS__.invoke("e2e_resize", { width, height });
    const t0 = performance.now();
    while (Math.abs(window.innerWidth - width) > 1 && performance.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 40));
    await new Promise((r) => setTimeout(r, 150));
    return [window.innerWidth, window.innerHeight];
  },
};
