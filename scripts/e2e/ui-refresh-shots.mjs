// Screenshots and layout checks of the 1.15 refresh against the MOCK UI in headless Chromium (no app binary, no WKWebView):
// the Agent run, the Dashboard and the New run dialog in Standard and Glass, light and dark, at 1440x900 and 960x600.
// Every shot is audited in the page: text contrast below 4.5:1 (3:1 for large text), controls that are covered or off screen,
// and a page that scrolls sideways. What it cannot tell: how WKWebView (the Mac web view) paints; that needs scripts/shots.sh.
//
//   VITE_MOCK_IPC=1 pnpm --dir ui exec vite build --outDir ../.scratch/mock-ui      (or: pnpm --dir ui dev)
//   node scripts/e2e/ui-refresh-shots.mjs [--dir .scratch/mock-ui | --base http://localhost:1420] [--out .scratch/refresh-shots]
//                                         [--locale hu] [--scale 2] [--only agent-run,dashboard,new-run]
// Playwright comes from PW_DIR (a folder with playwright-core, default .scratch/pw) or from a global install.
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

function loadChromium() {
  for (const from of [path.resolve(process.env.PW_DIR || ".scratch/pw") + "/package.json", import.meta.url]) {
    for (const name of ["playwright-core", "playwright"]) {
      try {
        return createRequire(from)(name).chromium;
      } catch {
        /* try the next place */
      }
    }
  }
  throw new Error("Playwright not found: set PW_DIR to a folder that has playwright-core, or install playwright globally");
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".wasm": "application/wasm" };

/** Serves a built mock bundle from a folder; resolves to its base URL and a close function. */
function serve(dir) {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(root, p);
    if (!file.startsWith(root) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

/**
 * Runs in the page; returns { low, covered, hscroll }. Backgrounds are alpha-composited up the ancestors (Glass tints end on
 * the base colour of the backdrop). The chosen item of a segmented control is skipped: its fill is a sibling (the thumb), and
 * accents.test.ts holds the on-accent ink to 4.5:1.
 */
function audit() {
  const parse = (c) => { const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?/.exec(c || ""); return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const base = () => { const dark = document.documentElement.getAttribute("data-theme") !== "light"; const glass = document.documentElement.getAttribute("data-skin") === "glass"; return glass ? (dark ? { r: 13, g: 16, b: 34, a: 1 } : { r: 238, g: 240, b: 251, a: 1 }) : parse(getComputedStyle(document.body).backgroundColor) ?? { r: 255, g: 255, b: 255, a: 1 }; };
  const bgOf = (el) => { const layers = []; for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } } let bg = layers.length && layers[layers.length - 1].a >= 1 ? layers.pop() : base(); for (const l of layers.reverse()) bg = over(l, bg); return bg; };
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 1 && r.height > 1 && cs.visibility !== "hidden" && cs.display !== "none" && +cs.opacity > 0.05 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
  const hiddenUp = (el) => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.visibility === "hidden" || +cs.opacity < 0.05 || n.hasAttribute("inert") || n.getAttribute("aria-hidden") === "true") return true; } return false; };
  const low = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const el = t.parentElement; if (!el || seen.has(el) || !t.nodeValue.trim()) continue; seen.add(el);
    if (!visible(el) || hiddenUp(el)) continue;
    if (el.closest("[disabled], [aria-disabled='true'], .ui-sr-only, .cm-editor, .xterm, .dpv__sign, .ui-kbd, .ui-seg__item[aria-checked='true']")) continue;
    const cs = getComputedStyle(el); const fg0 = parse(cs.color); if (!fg0) continue;
    const bg = bgOf(el); const fg = over(fg0, bg); const r = ratio(fg, bg);
    const big = parseFloat(cs.fontSize) >= 18.66 || (parseFloat(cs.fontSize) >= 14 && +cs.fontWeight >= 700);
    if (r < (big ? 3 : 4.5)) low.push(`${r.toFixed(2)} ${el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : el.tagName} "${t.nodeValue.trim().slice(0, 28)}"`);
  }
  const covered = [];
  for (const el of document.querySelectorAll("button, a[href], input, textarea, select, [role='radio'], [role='tab']")) {
    if (!visible(el) || hiddenUp(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.left < -1 || r.top < -1) {
      // off-screen is fine inside a scroller; report only when no ancestor scrolls
      let scrolls = false; for (let n = el.parentElement; n; n = n.parentElement) { const cs = getComputedStyle(n); if (/(auto|scroll)/.test(cs.overflowY + cs.overflowX)) { scrolls = true; break; } }
      if (!scrolls) covered.push(`offscreen ${el.getAttribute("aria-label") ?? el.textContent.trim().slice(0, 24)}`);
      continue;
    }
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2; const top = document.elementFromPoint(cx, cy);
    if (top && !el.contains(top) && !top.contains(el) && !top.closest(".ui-toast, .ui-toaster, .ui-tooltip")) {
      const label = el.getAttribute("aria-label") ?? el.textContent.trim().slice(0, 24);
      // clipped by its own scroller (centre scrolled out of view) is not an overlap
      let clipped = false; for (let n = el.parentElement; n; n = n.parentElement) { const cs = getComputedStyle(n); if (/(auto|scroll|hidden)/.test(cs.overflowY + cs.overflowX)) { const pr = n.getBoundingClientRect(); if (cy < pr.top || cy > pr.bottom || cx < pr.left || cx > pr.right) { clipped = true; break; } } }
      if (!clipped) covered.push(`covered "${label}" by ${top.className && typeof top.className === "string" ? "." + top.className.split(" ")[0] : top.tagName}`);
    }
  }
  return { low: [...new Set(low)].slice(0, 25), covered: [...new Set(covered)].slice(0, 25), hscroll: document.documentElement.scrollWidth > innerWidth };
}

const VIEWS = {
  "agent-run": {
    url: "/?scenario=agent-permission&mode=agent",
    steps: async (page) => {
      await page.locator(".run-card, .run-row__main").first().click();
      await page.locator('[data-testid="composer"]').waitFor();
    },
  },
  dashboard: {
    url: "/?scenario=agent-normal&mode=editor",
    // the Commit panel closed, so the Dashboard has the width of the window
    storage: { "intely.layout.panel": "0" },
    steps: async (page) => {
      await page.locator('[data-testid="dashboard"]').waitFor();
    },
  },
  "new-run": {
    url: "/?scenario=agent-normal&mode=agent",
    steps: async (page) => {
      await page.locator(".sessions__bar .ui-btn").last().click();
      await page.locator('[role="dialog"]').waitFor();
    },
  },
};
const SIZES = [[1440, 900], [960, 600]];

const dir = arg("dir");
const out = arg("out", ".scratch/refresh-shots");
const locale = arg("locale", "");
const scale = Number(arg("scale", "1"));
const only = arg("only", Object.keys(VIEWS).join(",")).split(",");
fs.mkdirSync(out, { recursive: true });
const served = dir ? await serve(dir) : null;
const base = served?.base ?? arg("base", "http://localhost:1420");
const browser = await loadChromium().launch();
let failed = 0;

for (const view of only) {
  const spec = VIEWS[view];
  if (!spec) {
    console.log(`FAIL  unknown view ${view}`);
    failed++;
    continue;
  }
  for (const skin of ["standard", "glass"]) {
    for (const theme of ["dark", "light"]) {
      for (const [w, h] of SIZES) {
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, deviceScaleFactor: scale });
        await ctx.addInitScript(([t, l, extra]) => {
          try {
            localStorage.setItem("intely.theme", t);
            if (l) localStorage.setItem("intely.locale", l);
            for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v);
          } catch {
            /* blocked storage: the defaults show */
          }
        }, [theme, locale, spec.storage ?? {}]);
        const page = await ctx.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        const name = `${view}-${skin}-${theme}-${w}x${h}${locale ? `-${locale}` : ""}`;
        try {
          await page.goto(`${base}${spec.url}&skin=${skin}`);
          await page.locator('[data-testid="shell"]').waitFor();
          await spec.steps(page);
          // Toasts cover what is under them for a few seconds: close them before the shot.
          for (const close of await page.locator(".ui-toast button[aria-label]").all()) await close.click().catch(() => {});
          await page.waitForTimeout(900);
          await page.screenshot({ path: path.join(out, `${name}.png`) });
          const a = await page.evaluate(audit);
          const findings = [...a.low.map((l) => `contrast ${l}`), ...a.covered, ...(a.hscroll ? ["the page scrolls sideways"] : []), ...errors.map((e) => `page error: ${e}`)];
          console.log(`${findings.length ? "FAIL" : "PASS"}  ${name}${findings.map((f) => `\n      ${f}`).join("")}`);
          if (findings.length) failed++;
        } catch (e) {
          console.log(`FAIL  ${name}\n      ${String(e.message).split("\n")[0]}`);
          failed++;
        }
        await ctx.close();
      }
    }
  }
}

await browser.close();
served?.close();
console.log(failed ? `${failed} shot(s) with findings` : "all shots clean");
process.exit(failed ? 1 : 0);
