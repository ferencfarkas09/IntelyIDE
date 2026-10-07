// Helpers of the screenshot tours (shots.sh concatenates config.js, lib.js, this file and one tour). A shot is named
// <scenario>-<name>-<theme>.png by window.__e2e.screenshot; `both` takes it in dark and in light.

/** Applies a theme the way the theme controller does (the attribute the stylesheet keys on). */
async function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  await sleep(900); // colour transitions of the theme switch must have finished
}

/** The current UI state in dark and in light; ends on dark. Returns the file paths. */
async function both(name) {
  const files = [];
  for (const theme of ["dark", "light"]) {
    await setTheme(theme);
    files.push(await window.__e2e.screenshot(name));
  }
  await setTheme("dark");
  return files;
}

let hoverSheet;
/** Emulates `:hover` on `el` and its ancestors (a dispatched event cannot move the pointer): every `:hover` rule is cloned onto `.__hover`. */
function forceHover(el) {
  if (!hoverSheet) {
    const rules = [];
    const walk = (list, wrap) => {
      for (const r of list) {
        if (r instanceof CSSStyleRule && r.selectorText.includes(":hover")) {
          const css = r.cssText.replace(/:hover/g, ".__hover");
          rules.push(wrap ? `${wrap} { ${css} }` : css);
        } else if (r instanceof CSSMediaRule && matchMedia(r.conditionText).matches) walk(r.cssRules, wrap);
      }
    };
    for (const sheetObj of document.styleSheets) {
      try { walk(sheetObj.cssRules, ""); } catch { /* cross-origin sheet */ }
    }
    hoverSheet = new CSSStyleSheet();
    hoverSheet.replaceSync(rules.join("\n"));
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, hoverSheet];
    notes.hoverRules = rules.length;
  }
  const chain = [];
  for (let n = el; n && n !== document.documentElement; n = n.parentElement) { n.classList.add("__hover"); chain.push(n); }
  return () => chain.forEach((n) => n.classList.remove("__hover"));
}

async function ticksOnly(...ids) {
  for (const id of FX.repoIds) if (!ids.includes(id)) await untickRepo(id);
  for (const id of ids) await setTick(repoRowSel(id), "true", `repo ${id}`);
}

// ---- demo tour helpers (RC16, append-only): deterministic frames, masked fixture paths, text dump for the forbidden-string checks ----

/** Stops animations, transitions and the blinking caret; idempotent. */
function freezeUi() {
  if (document.getElementById("__shots-freeze")) return;
  const style = document.createElement("style");
  style.id = "__shots-freeze";
  style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; scroll-behavior: auto !important; } *:hover { scrollbar-width: none; }";
  (document.head ?? document.documentElement).appendChild(style);
}

/** Replaces Date by a frozen-clock subclass (relative times do not drift); records the clock in the notes. */
function freezeClock(iso) {
  const fixed = new Date(iso).getTime();
  if (Number.isNaN(fixed)) throw new Error(`freezeClock: bad date "${iso}"`);
  const Real = globalThis.__RealDate ?? Date;
  globalThis.__RealDate = Real;
  class FrozenDate extends Real {
    constructor(...args) { if (args.length === 0) super(fixed); else super(...args); }
    static now() { return fixed; }
  }
  globalThis.Date = FrozenDate;
  notes.clock = `frozen ${iso.replace(/\.\d+Z$/, "Z")}`;
}

/** Two animation frames, no running animation, then 400 ms (rAF can stall in an occluded window, hence the bounded waits). */
async function settle() {
  await frame();
  await frame();
  const t0 = performance.now(); // not Date: freezeClock freezes it
  while (typeof document.getAnimations === "function" && document.getAnimations().length > 0 && performance.now() - t0 < 3000) await sleep(50);
  await sleep(400);
}

/** The visible-state fingerprint snapStable compares: visible text plus the geometry of the first 3000 elements. */
function uiFingerprint() {
  let h = 0;
  const mix = (s) => { for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0; };
  mix(document.body?.innerText ?? "");
  for (const el of [...document.querySelectorAll("*")].slice(0, 3000)) {
    const r = el.getBoundingClientRect();
    mix(`${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)};`);
  }
  return h;
}

/** A screenshot taken between two identical UI fingerprints (and, when the host offers `__e2e.fileHash`, two identical files); retries up to 3 times. */
async function snapStable(name) {
  let file;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = uiFingerprint();
    file = await window.__e2e.screenshot(name);
    await sleep(300);
    let stable = uiFingerprint() === before;
    if (stable && typeof window.__e2e.fileHash === "function") {
      const again = await window.__e2e.screenshot(`${name}-chk`);
      stable = (await window.__e2e.fileHash(file)) === (await window.__e2e.fileHash(again));
    }
    if (stable) return file;
    (notes.unstable ??= []).push(`${name}: attempt ${attempt}`);
  }
  return file; // the last frame; the note above flags it for review
}

const parseRgb = (c) => { const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?/.exec(c || ""); return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null; };
const luminance = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrastRatio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
/** First opaque background up the ancestor chain; the page default (white) when none. */
function effectiveBackground(el) {
  for (let n = el; n; n = n.parentElement) {
    const c = parseRgb(getComputedStyle(n).backgroundColor);
    if (c && c.a > 0.5) return c;
  }
  return { r: 255, g: 255, b: 255, a: 1 };
}

/** Throws unless every visible match of `selector` has a foreground/background contrast of at least 4.5. */
function assertReadable(selector, min = 4.5) {
  const els = [...document.querySelectorAll(selector)].filter((e) => e.offsetParent !== null || getComputedStyle(e).position === "fixed");
  if (els.length === 0) throw new Error(`assertReadable: nothing matches "${selector}"`);
  for (const el of els) {
    const fg = parseRgb(getComputedStyle(el).color);
    const ratio = fg ? contrastRatio(fg, effectiveBackground(el)) : 0;
    if (ratio < min) throw new Error(`assertReadable: "${selector}" contrast ${ratio.toFixed(2)} < ${min} ("${(el.textContent ?? "").trim().slice(0, 40)}")`);
  }
}

/** Throws unless the page background luminance matches the theme (dark < 0.4 < light). */
function assertTheme(theme) {
  const bg = effectiveBackground(document.body);
  const lum = luminance(bg);
  if (theme === "dark" ? lum >= 0.4 : lum < 0.4) throw new Error(`assertTheme: ${theme} requested but the body background has luminance ${lum.toFixed(2)}`);
}

const MASK_ATTRS = ["title", "aria-label", "placeholder"];
/** Replaces the fixture root in visible text nodes and title/aria-label/placeholder attributes by `~/fernbank`; returns the count (also added to notes.masked). */
function maskFixtureRoot() {
  const root = FX.root;
  const real = [root];
  try { if (root.startsWith("/var/")) real.push(`/private${root}`); } catch { /* ignore */ }
  let count = 0;
  const swap = (s) => { let out = s; for (const r of real) if (out.includes(r)) { count += out.split(r).length - 1; out = out.split(r).join("~/fernbank"); } return out; };
  const walker = document.createTreeWalker(document.body, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) { const v = swap(n.nodeValue ?? ""); if (v !== n.nodeValue) n.nodeValue = v; }
  for (const el of document.querySelectorAll("[title],[aria-label],[placeholder]")) {
    for (const a of MASK_ATTRS) { const v = el.getAttribute(a); if (v !== null) { const w = swap(v); if (w !== v) el.setAttribute(a, w); } }
  }
  notes.masked = (notes.masked ?? 0) + count;
  if (count > 5) (notes.maskReview ??= []).push(`${count} replacements`);
  return count;
}

/** Collects visible text, attribute strings and the terminal text into notes.shots[]; the host pipeline scans it with the forbidden rules. */
function dumpVisibleText(name, theme) {
  const attrs = [];
  for (const el of document.querySelectorAll("[title],[aria-label],[placeholder],[alt]")) for (const a of [...MASK_ATTRS, "alt"]) { const v = el.getAttribute(a); if (v) attrs.push(v); }
  let terminal = "";
  for (const rows of document.querySelectorAll(".xterm-rows")) terminal += `${rows.textContent ?? ""}\n`;
  if (typeof window.__intelyTermText === "function") { try { terminal += String(window.__intelyTermText()); } catch { /* no hook */ } }
  const entry = { shot: name, theme, text: (document.body?.innerText ?? "").trim(), attrs, terminal: terminal.trim() };
  (notes.shots ??= []).push(entry);
  return entry;
}

/** Dark then light: setTheme, assertTheme, assertReadable (for the selectors given), dumpVisibleText, snapStable. Ends on dark. */
async function snapBoth(name, readableSelectors = []) {
  const files = [];
  for (const theme of ["dark", "light"]) {
    await setTheme(theme);
    await settle();
    assertTheme(theme);
    for (const sel of readableSelectors) assertReadable(sel);
    maskFixtureRoot();
    dumpVisibleText(name, theme);
    files.push(await snapStable(name));
  }
  await setTheme("dark");
  return files;
}
