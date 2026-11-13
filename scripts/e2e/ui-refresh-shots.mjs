// Screenshots and layout checks of the 1.15 refresh against the MOCK UI in headless Chromium (no app binary, no WKWebView):
// the Agent run with a permission request, a question, a plan to approve, two requests at once, a request with a 200-character
// path and one with a long command, a finished and a throttled run, the Dashboard and the New run dialog in Standard and Glass,
// light and dark, at 1440x900, 1100x700 and 960x600, and two stacked panes at 1440x900.
// Every shot is audited in the page: text contrast below 4.5:1 (3:1 for large text, badges included), controls that are covered
// or off screen, a focused control that is not fully on screen, a request card whose title, target line or buttons are not
// fully inside the visible part of the transcript, a transcript whose VISIBLE scroll area (the scroller minus whatever lies over
// it) is shorter than 200 px, header chips or a page that scroll sideways. The two-request view also plays the keyboard
// sequence: Enter on the focused "Allow once", then the other card must be fully on screen with the focus, unanswered by an
// Enter that came straight after. What it cannot tell: how WKWebView (the Mac web view) paints; that needs scripts/shots.sh.
//
//   VITE_MOCK_IPC=1 pnpm --dir ui exec vite build --outDir ../.scratch/mock-ui      (or: pnpm --dir ui dev)
//   node scripts/e2e/ui-refresh-shots.mjs [--dir .scratch/mock-ui | --base http://localhost:1420] [--out .scratch/refresh-shots]
//                                         [--locale hu] [--scale 2] [--only agent-run,question,plan,two-requests,context-meter,plan-usage,...]
//                                         [--skins standard,glass] [--themes dark,light] [--sizes 960x600,1440x900]
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
function audit(opts = {}) {
  const minRoom = opts.minRoom ?? 200;
  const parse = (c) => { const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?/.exec(c || ""); return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const base = () => { const dark = document.documentElement.getAttribute("data-theme") !== "light"; const glass = document.documentElement.getAttribute("data-skin") === "glass"; return glass ? (dark ? { r: 13, g: 16, b: 34, a: 1 } : { r: 238, g: 240, b: 251, a: 1 }) : parse(getComputedStyle(document.body).backgroundColor) ?? { r: 255, g: 255, b: 255, a: 1 }; };
  const bgOf = (el) => { const layers = []; for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } } let bg = layers.length && layers[layers.length - 1].a >= 1 ? layers.pop() : base(); for (const l of layers.reverse()) bg = over(l, bg); return bg; };
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 1 && r.height > 1 && cs.visibility !== "hidden" && cs.display !== "none" && +cs.opacity > 0.05 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
  const hiddenUp = (el) => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.visibility === "hidden" || +cs.opacity < 0.05 || n.hasAttribute("inert")) return true; } return false; };
  // A modal dialog covers the window on purpose: with one open, only what is inside it is checked.
  const modal = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter(visible).pop();
  const inScope = (el) => !modal || modal.contains(el);
  const low = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const el = t.parentElement; if (!el || seen.has(el) || !t.nodeValue.trim()) continue; seen.add(el);
    if (!visible(el) || hiddenUp(el) || !inScope(el)) continue;
    if (el.closest("[disabled], [aria-disabled='true'], .ui-sr-only, .cm-editor, .xterm, .dpv__sign, .ui-kbd, .pmark, .ui-seg__item[aria-checked='true']")) continue;
    const cs = getComputedStyle(el); const fg0 = parse(cs.color); if (!fg0) continue;
    const bg = bgOf(el); const fg = over(fg0, bg); const r = ratio(fg, bg);
    const big = parseFloat(cs.fontSize) >= 18.66 || (parseFloat(cs.fontSize) >= 14 && +cs.fontWeight >= 700);
    if (r < (big ? 3 : 4.5)) low.push(`${r.toFixed(2)} ${el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : el.tagName} "${t.nodeValue.trim().slice(0, 28)}"`);
  }
  const covered = [];
  for (const el of document.querySelectorAll("button, a[href], input, textarea, select, [role='radio'], [role='tab']")) {
    if (!visible(el) || hiddenUp(el) || !inScope(el)) continue;
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
  // What has the keyboard focus must be on screen: inside the window and inside every scroller or clip around it. A focused
  // "Allow once" under the run header would be pressed by Enter without having been seen.
  const focus = [];
  const active = document.activeElement;
  if (active && active !== document.body && inScope(active)) {
    const r = active.getBoundingClientRect();
    let box = { top: 0, left: 0, bottom: innerHeight, right: innerWidth };
    for (let n = active.parentElement; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (!/(auto|scroll|hidden|clip)/.test(cs.overflowY + cs.overflowX)) continue;
      const pr = n.getBoundingClientRect();
      box = { top: Math.max(box.top, pr.top), left: Math.max(box.left, pr.left), bottom: Math.min(box.bottom, pr.bottom), right: Math.min(box.right, pr.right) };
    }
    if (r.top < box.top - 1 || r.bottom > box.bottom + 1 || r.left < box.left - 1 || r.right > box.right + 1) {
      focus.push(`the focused control "${(active.getAttribute("aria-label") ?? active.textContent ?? "").trim().slice(0, 30)}" is not fully on screen (${Math.round(r.top)}-${Math.round(r.bottom)} in ${Math.round(box.top)}-${Math.round(box.bottom)})`);
    }
  }
  // The visible rectangle of a scroller: its client box, cut by the window.
  const viewOf = (scroller) => { const r = scroller.getBoundingClientRect(); const top = r.top + scroller.clientTop; return { top: Math.max(0, top), bottom: Math.min(innerHeight, top + scroller.clientHeight), left: Math.max(0, r.left + scroller.clientLeft), right: Math.min(innerWidth, r.left + scroller.clientLeft + scroller.clientWidth) }; };
  const inside = (el, box) => { const r = el.getBoundingClientRect(); return r.height > 0 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1 && r.left >= box.left - 1 && r.right <= box.right + 1; };
  const span = (el) => { const r = el.getBoundingClientRect(); return `${Math.round(r.top)}-${Math.round(r.bottom)}`; };
  // The conversation must keep a usable height in the smallest window: what counts is the part of the scroller that can be
  // seen, so whatever lies over it (the cards above the transcript, the typing line, a banner, the jump button) is taken off.
  // Sampled row by row at two x positions; the longest run of rows that show the scroller's own content is the visible area.
  const room = [];
  const sizes = [];
  const transient = ".ui-toast, .ui-toaster, .ui-tooltip";
  const scrollers = modal ? [] : [...document.querySelectorAll('[data-testid="transcript"] .ui-scroll__viewport')].filter(visible);
  for (const scroller of scrollers) {
    const box = viewOf(scroller);
    const xs = [box.left + (box.right - box.left) * 0.3, box.left + (box.right - box.left) * 0.6];
    let best = 0, run = 0;
    for (let y = Math.ceil(box.top); y < Math.floor(box.bottom); y++) {
      const free = xs.every((x) => { const top = document.elementsFromPoint(x, y + 0.5).find((el) => !el.closest(transient)); return !!top && scroller.contains(top); });
      run = free ? run + 1 : 0;
      best = Math.max(best, run);
    }
    const chat = scroller.closest(".chat");
    const h = (sel) => { const el = chat?.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().height) : 0; };
    sizes.push({ header: h(".run-header"), composer: h(".composer"), transcript: best });
    if (best < minRoom) room.push(`the visible transcript is ${best} px tall (minimum ${minRoom}; the scroller is ${Math.round(box.bottom - box.top)} px, header ${h(".run-header")}, composer ${h(".composer")})`);
  }
  const chips = modal ? null : document.querySelector(".run-header__chips");
  if (chips && chips.scrollWidth > chips.clientWidth + 1 && getComputedStyle(chips).display !== "contents") room.push("the header chips scroll sideways");
  // Request cards (permission, question, plan). In each transcript one card is the one to answer: the one with the focus, else
  // the one that shows most of itself. Its title, its target line and every button of its action row must be fully inside the
  // visible rectangle of the scroller and inside the card (a card that scrolls as a whole hides its own top or foot), and no
  // button may have the focus unless it is fully visible there.
  const cards = [];
  for (const scroller of scrollers) {
    const box = viewOf(scroller);
    const open = [...scroller.querySelectorAll("section.perm")];
    if (!open.length) continue;
    const shown = (c) => { const r = c.getBoundingClientRect(); return Math.max(0, Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top)); };
    const current = open.find((c) => c.contains(active)) ?? open.slice().sort((a, b) => shown(b) - shown(a))[0];
    const cardBox = (() => { const r = current.getBoundingClientRect(); return { top: Math.max(r.top, box.top), bottom: Math.min(r.bottom, box.bottom), left: box.left, right: box.right }; })();
    const name = (current.getAttribute("aria-label") ?? "request").slice(0, 30);
    const parts = [["title", current.querySelector(".perm__title")], ...(current.matches(".plan-approval") ? [] : [["target line", current.querySelector(".perm__target")]]), ...[...current.querySelectorAll(".perm__foot .perm__actions button")].map((b) => [`button "${b.textContent.trim().slice(0, 24)}"`, b])];
    if (parts.length < 2) cards.push(`${name}: no action button found`);
    if (!inside(current, box)) cards.push(`${name}: the card is not fully inside the transcript's visible area (${span(current)} in ${Math.round(box.top)}-${Math.round(box.bottom)})`);
    for (const [what, el] of parts) {
      if (!el) cards.push(`${name}: no ${what}`);
      else if (!inside(el, cardBox)) cards.push(`${name}: the ${what} is not fully visible (${span(el)} in ${Math.round(cardBox.top)}-${Math.round(cardBox.bottom)})`);
    }
    for (const c of open) {
      if (c.contains(active) && active.matches("button, [role='radio']")) {
        const r = c.getBoundingClientRect();
        let clip = { top: Math.max(r.top, box.top), bottom: Math.min(r.bottom, box.bottom), left: box.left, right: box.right };
        const body = active.closest(".perm__body");
        if (body) { const b = body.getBoundingClientRect(); clip = { ...clip, top: Math.max(clip.top, b.top), bottom: Math.min(clip.bottom, b.bottom) }; }
        if (!inside(active, clip)) cards.push(`${name}: the focus is on "${active.textContent.trim().slice(0, 24)}", which is not fully visible (${span(active)} in ${Math.round(clip.top)}-${Math.round(clip.bottom)})`);
      }
    }
  }
  return { low: [...new Set(low)].slice(0, 25), covered: [...new Set([...covered, ...focus, ...room, ...cards])].slice(0, 25), hscroll: document.documentElement.scrollWidth > innerWidth, sizes };
}

/** Where the keyboard focus is among the open request cards of the page: the card's index and whether it is on its first-choice button. */
const focusState = (page) => page.evaluate(() => {
  const open = [...document.querySelectorAll("section.perm")];
  const a = document.activeElement;
  return { open: open.length, card: open.findIndex((c) => c.contains(a)), primary: !!a?.hasAttribute?.("data-primary"), label: (a?.textContent ?? "").trim().slice(0, 30) };
});

/**
 * Two requests wait. Enter on the focused "Allow once" (after the 600 ms key guard) answers the first; the second must then be
 * fully visible and hold the focus, and neither an Enter pressed straight after the first nor one pressed just after the focus
 * moved may have answered it. A last Enter, after the guard, answers it: the keyboard still works.
 */
async function twoRequestSequence(page, { name, out, minRoom }) {
  const findings = [];
  const start = await focusState(page);
  if (start.open !== 2) return [`sequence: expected 2 open requests, found ${start.open}`];
  if (start.card !== 0 || !start.primary) findings.push(`sequence: the focus is not on the first request's first choice (card ${start.card}, "${start.label}")`);
  await page.waitForTimeout(700);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter"); // already on its way when the first card went away
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter"); // the focus has just arrived on the other card: still guarded
  await page.waitForTimeout(700);
  const after = await focusState(page);
  if (after.open !== 1) findings.push(`sequence: ${after.open} request(s) open after one Enter and two early ones (expected 1: the second must not be answered unseen)`);
  else if (after.card !== 0 || !after.primary) findings.push(`sequence: the second request does not hold the focus on its first choice (focus on "${after.label}")`);
  await page.screenshot({ path: path.join(out, `${name}-after-enter.png`) });
  const a = await page.evaluate(audit, { minRoom });
  findings.push(...a.covered.map((f) => `after Enter: ${f}`));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  const end = await focusState(page);
  if (end.open !== 0) findings.push(`sequence: ${end.open} request(s) still open after Enter on the second one, past the guard`);
  return findings;
}

const openRun = async (page, which = "first") => {
  await page.locator(".run-card, .run-row__main")[which]().click();
  await page.locator('[data-testid="composer"]').first().waitFor();
};

const VIEWS = {
  "agent-run": {
    url: "/?scenario=agent-permission&mode=agent",
    steps: async (page) => {
      await page.locator(".run-card, .run-row__main").first().click();
      await page.locator('[data-testid="composer"]').waitFor();
      // the request that waits: its card takes the focus when it appears
      await page.locator('section.perm[role="group"]').waitFor();
    },
  },
  // A question that waits for an answer: the focused option and the Send button must be on screen too.
  question: {
    url: "/?scenario=agent-question&mode=agent",
    steps: async (page) => {
      await page.locator(".run-card, .run-row__main").first().click();
      await page.locator(".perm.q").waitFor();
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
  // A plan that waits for approval: the title, the mode to continue in and Approve are on screen together; the plan scrolls inside the card.
  plan: {
    url: "/?scenario=agent-plan&mode=agent",
    steps: async (page) => {
      await openRun(page);
      await page.locator('[data-testid="plan-approval"]').waitFor();
    },
  },
  // Two requests at once: the first has the focus; then the keyboard sequence.
  "two-requests": {
    url: "/?scenario=agent-two-requests&mode=agent",
    steps: async (page) => {
      await openRun(page);
      await page.locator("section.perm").nth(1).waitFor();
    },
    sequence: twoRequestSequence,
  },
  // What is asked does not fit on a line: a 200-character path, a command of several long lines.
  "long-path": {
    url: "/?scenario=agent-long-path&mode=agent",
    steps: async (page) => {
      await openRun(page);
      await page.locator('section.perm[role="group"]').waitFor();
    },
  },
  "long-command": {
    url: "/?scenario=agent-long-command&mode=agent",
    steps: async (page) => {
      await openRun(page);
      await page.locator('section.perm[role="group"]').waitFor();
    },
  },
  // A finished run (its summary card sits above the transcript) and a throttled one (the notice sits above the composer).
  finished: {
    url: "/?scenario=agent-normal&mode=agent",
    steps: async (page) => {
      await openRun(page, "last");
      await page.locator('[data-testid="transcript"]').waitFor();
    },
  },
  throttle: {
    url: "/?scenario=agent-throttle&mode=agent",
    steps: async (page) => {
      await openRun(page);
      await page.locator('.chat > .banner[data-tone="warn"]').waitFor();
    },
  },
  // Two panes on top of each other: a waiting run above, a finished one below. Each keeps a transcript worth reading.
  stacked: {
    url: "/?scenario=agent-permission&mode=agent",
    sizes: [[1440, 900]],
    minRoom: 150,
    steps: async (page) => {
      await openRun(page);
      // the fourth layout of the switcher is "two rows"
      await page.locator('[data-testid="pane-bar"] [role="radio"]').nth(3).click();
      await page.locator('[data-testid="run-pane"]').nth(1).waitFor();
      await page.locator('[data-testid="run-pane"]').nth(1).click({ position: { x: 40, y: 60 } });
      await page.locator(".run-card, .run-row__main").last().click();
      await page.locator('[data-testid="run-pane"] [data-testid="composer"]').nth(1).waitFor();
      await page.locator('[data-testid="run-pane"] section.perm[role="group"]').waitFor();
    },
  },
};
// The context meter and the plan usage of the bottom bar (the mock's demo numbers): the ring's popover on the live run, on a
// finished run past the warning colour, and the plan-usage popover with the three states of a bar item beside it.
const openRing = async (page, percent) => {
  const ring = page.locator('[data-testid="context-ring"]');
  await ring.filter({ hasText: `${percent}%` }).waitFor({ timeout: 20_000 });
  await ring.click();
  await page.locator('[data-testid="context-meter"]').waitFor();
};
Object.assign(VIEWS, {
  "context-meter": {
    url: "/?scenario=agent-normal&mode=agent",
    steps: async (page) => {
      await page.locator(".run-card, .run-row__main").first().click();
      await openRing(page, 31);
    },
  },
  "context-meter-warn": {
    url: "/?scenario=agent-normal&mode=agent",
    steps: async (page) => {
      await page.locator(".run-card, .run-row__main").filter({ hasText: "Which routes" }).first().click();
      await openRing(page, 78);
      await page.locator('[data-testid="context-meter-pace"]').waitFor();
    },
  },
  "plan-usage": {
    url: "/?scenario=agent-normal&mode=agent",
    steps: async (page) => {
      await page.locator(".run-card, .run-row__main").first().click();
      await page.locator('[data-testid="plan-item-weekly"]').waitFor({ timeout: 20_000 });
      await page.locator('[data-testid="plan-item-scoped"]').first().click();
      await page.locator('[data-testid="plan-usage"]').waitFor();
    },
  },
});
const SIZES = [[1440, 900], [1100, 700], [960, 600]];

const dir = arg("dir");
const out = arg("out", ".scratch/refresh-shots");
const locale = arg("locale", "");
const scale = Number(arg("scale", "1"));
const only = arg("only", Object.keys(VIEWS).join(",")).split(",");
const skins = arg("skins", "standard,glass").split(",");
const themes = arg("themes", "dark,light").split(",");
const sizeFilter = arg("sizes", "");
const sizesOf = (spec) => (spec.sizes ?? SIZES).filter(([w, h]) => !sizeFilter || sizeFilter.split(",").includes(`${w}x${h}`));
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
  for (const skin of skins) {
    for (const theme of themes) {
      for (const [w, h] of sizesOf(spec)) {
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
          const minRoom = spec.minRoom ?? 200;
          const a = await page.evaluate(audit, { minRoom });
          const findings = [...a.low.map((l) => `contrast ${l}`), ...a.covered, ...(a.hscroll ? ["the page scrolls sideways"] : [])];
          if (spec.sequence) findings.push(...(await spec.sequence(page, { name, out, minRoom })));
          findings.push(...errors.map((e) => `page error: ${e}`));
          // header / composer / visible transcript of each pane, for the record
          const sizes = a.sizes.map((s) => `${s.header}/${s.composer}/${s.transcript}`).join("  ");
          console.log(`${findings.length ? "FAIL" : "PASS"}  ${name}${sizes ? `  [header/composer/visible transcript ${sizes}]` : ""}${findings.map((f) => `\n      ${f}`).join("")}`);
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
