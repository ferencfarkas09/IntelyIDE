#!/usr/bin/env node
// Captures the product screenshots of the marketing site from the real UI (ui/, SolidJS) running against its browser mock
// backend, in headless Google Chrome driven over the DevTools Protocol (no npm dependencies, Node 24+).
//
//   node site/scripts/capture-shots.mjs                       # all shots, light + dark, 2880x1800 PNG
//   node site/scripts/capture-shots.mjs hero push-dialog      # only these shots
//   node site/scripts/capture-shots.mjs --theme dark          # only one theme
//   node site/scripts/capture-shots.mjs --quick               # 1440x900 (dsf 1) into $TMPDIR/intely-shots, for iterating
//   node site/scripts/capture-shots.mjs --out <dir> ...       # 2880x1800 into <dir> instead of the site image folder
//
// Needs a Vite dev server for ui/ (default http://localhost:1420, override with --url or SHOTS_URL). If none is running:
//   cd ui && pnpm exec vite --port 1431 --strictPort      then   --url http://localhost:1431
// Data: only the fictional `showcase` mock scenario ("Acme Shop", ui/src/ipc/mock/showcase.ts and mock-agent.ts). The preview
// shot also starts a tiny local HTTP server serving a fictional storefront page for the Preview panel to embed.
// Output: site/src/static/assets/img/shots/<name>-<light|dark>-2880.png. The theme is forced through the app's own storage
// key (intely.theme), never the OS setting. Nothing is edited after capture; no desktop capture is used.
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome } from "./cdp.mjs";
import { DEMO_PAGE } from "./shots-demo-page.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
const BASE = (opt("url") ?? process.env.SHOTS_URL ?? "http://localhost:1420").replace(/\/$/, "");
const QUICK = flag("quick");
const THEMES = opt("theme") ? [opt("theme")] : ["light", "dark"];
const here = dirname(fileURLToPath(import.meta.url));
const OUT = opt("out") ? resolve(opt("out")) : QUICK ? join(tmpdir(), "intely-shots") : join(here, "../src/static/assets/img/shots");
const DSF = QUICK ? 1 : 2;
const names = argv.filter((a, i) => !a.startsWith("--") && !["--url", "--theme", "--out"].includes(argv[i - 1]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- helpers ----------------------------------------------------------------------------------------------
const text = (c) => c.eval(`document.body.innerText`);
const waitText = (c, s, t = 20000) => c.waitFor(`document.body.innerText.includes(${JSON.stringify(s)})`, t, `text "${s}"`);
const clickRail = async (c, label) => (await c.clickEl("button", label), await c.settle());
/** Clicks a row of the Changes tree / any tree by its visible text. */
async function clickRow(c, label) {
  const pt = await c.eval(`(() => { const r = [...document.querySelectorAll(".ui-tree-row")].find((e) => e.textContent.includes(${JSON.stringify(label)})); if (!r) return null; r.scrollIntoView({ block: "nearest" }); const b = r.getBoundingClientRect(); return { x: b.x + Math.min(b.width / 2, 120), y: b.y + b.height / 2 }; })()`);
  if (!pt) throw new Error(`no tree row "${label}"`);
  await c.click(pt.x, pt.y);
  await c.settle();
}
/** Clicks the deepest element (inside `scope`) whose text contains `label`; real mouse events at its centre. */
async function clickText(c, label, scope = "body") {
  const pt = await c.eval(`(() => {
    const root = document.querySelector(${JSON.stringify(scope)}); if (!root) return null;
    const hit = [...root.querySelectorAll("*")].filter((e) => (e.textContent || "").trim().includes(${JSON.stringify(label)}) && ![...e.children].some((k) => (k.textContent || "").includes(${JSON.stringify(label)})));
    const e = hit.find((x) => x.getBoundingClientRect().width > 0); if (!e) return null;
    e.scrollIntoView({ block: "nearest" }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  })()`);
  if (!pt) throw new Error(`no element with text "${label}" in ${scope}`);
  await c.click(pt.x, pt.y);
  await c.settle();
}
async function dismissToasts(c) {
  for (let i = 0; i < 6; i++) {
    const n = await c.eval(`(() => { const b = [...document.querySelectorAll('button[aria-label="Dismiss"]')]; b.forEach((x) => x.click()); return b.length; })()`);
    if (!n) break;
    await sleep(250);
  }
}
/** Types into a textarea/input matched by selector (focus by click, then real text input). */
async function typeInto(c, sel, value) {
  await c.clickEl(sel);
  await c.type(value);
  await sleep(150);
}
/** Picks an option of a native <select> by its aria-label, firing the events the UI listens to. */
async function selectOption(c, label, optionText) {
  const ok = await c.eval(`(() => { const s = document.querySelector('select[aria-label=${JSON.stringify(label)}]'); if (!s) return false; const o = [...s.options].find((x) => x.text.includes(${JSON.stringify(optionText)})); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event("input", { bubbles: true })); s.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  if (!ok) throw new Error(`no option ${optionText} in select ${label}`);
  await c.settle();
}
/** Grows/shrinks a splitter pane to its maximum (`toMax`) or minimum with the handle's own keyboard support. */
async function sizeSplitter(c, label, key, toMax) {
  await c.eval(`document.querySelector('[role=separator][aria-label=${JSON.stringify(label)}]').focus()`);
  const attr = toMax ? "aria-valuemax" : "aria-valuemin";
  for (let i = 0; i < 40; i++) {
    const [now, goal] = await c.eval(`(() => { const h = document.querySelector('[role=separator][aria-label=${JSON.stringify(label)}]'); return [Number(h.getAttribute("aria-valuenow")), Number(h.getAttribute(${JSON.stringify(attr)}))]; })()`);
    if (Math.abs(now - goal) < 2) break;
    await c.key(key, { code: key, vk: key === "ArrowLeft" ? 37 : 39, modifiers: mod.shift });
    await sleep(40);
  }
  await c.settle();
}
/** A loopback server for the fictional storefront page (started once, only when a shot needs it). */
let demoServer;
async function demoPort() {
  if (!demoServer) {
    demoServer = createServer((_q, r) => (r.setHeader("content-type", "text/html; charset=utf-8"), r.end(DEMO_PAGE)));
    await new Promise((r) => demoServer.listen(0, "127.0.0.1", r));
  }
  return demoServer.address().port;
}
const mod = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

async function open(c, { query = "", theme, scenario = "showcase" }) {
  await c.init(`try { localStorage.setItem("intely.theme", ${JSON.stringify(theme)}); localStorage.setItem("intely.extra.contract", "1"); } catch {}`);
  await c.goto(`${BASE}/?scenario=${scenario}&delay=0&${query}`);
  await c.waitFor(`document.body && document.body.innerText.length > 40`, 90000, "app render");
  await c.settle();
}

// ---------- shots ------------------------------------------------------------------------------------------------
const SHOTS = {
  async hero(c) {
    await clickRow(c, "OrdersTable.tsx");
    await typeInto(c, "textarea", "feat(orders): show totals with the shop currency");
    await clickRail(c, "Agents");
    await waitText(c, "Show order totals with the shop currency in the orders table");
    await c.clickEl("[class*=agent] *", "Show order totals with the shop currency in the orders table").catch(() => {});
    await c.settle();
    await dismissToasts(c);
  },
  async "changes-tree"(c) {
    await clickRow(c, "OrdersTable.tsx");
    await typeInto(c, "textarea", "feat(orders): show totals with the shop currency");
    await dismissToasts(c);
  },
  async "push-dialog"(c) {
    await c.key("K", { code: "KeyK", vk: 75, modifiers: mod.meta | mod.shift });
    await waitText(c, "Push");
    await dismissToasts(c);
  },
  async rewind(c) {
    await clickRail(c, "Run history");
    await dismissToasts(c);
    await clickText(c, "Show prices with the currency in the order list");
    await waitText(c, "Rewind");
    await c.clickEl("button", "Rewind");
    await waitText(c, "Rewind run");
    await clickText(c, "storefront-admin", "[role=dialog]");
    await waitText(c, "Dry run");
    await dismissToasts(c);
  },
  async "agent-approval"(c) {
    await c.clickEl(".ui-seg__item", "Agent");
    await waitText(c, "Permission needed");
    await dismissToasts(c);
  },
};

SHOTS.preview = async (c, theme) => {
  const port = await demoPort();
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  await dismissToasts(c);
  await clickRow(c, "OrdersTable.tsx");
  await clickRail(c, "Preview");
  await selectOption(c, "Repository", "storefront-admin");
  await selectOption(c, "Environment", "Local API");
  await c.clickEl('input[aria-label^="Preview address"]');
  await c.type(`localhost:${port}`);
  await c.key("Enter", { code: "Enter", vk: 13, text: "\r" });
  await waitText(c, "Server answers");
  await sizeSplitter(c, "Resize dock", "ArrowLeft", true);
  await selectOption(c, "Device", "Laptop 1280");
  await selectOption(c, "Zoom", "Fit");
  await c.eval(`document.activeElement?.blur?.()`);
  await sleep(800);
  await dismissToasts(c);
};

/** Opens Settings (rail) on one section (sidebar entry). */
async function openSettings(c, section) {
  await dismissToasts(c);
  await clickRail(c, "Settings");
  await waitText(c, "Appearance");
  await clickText(c, section, "[role=dialog] nav, [role=dialog]");
  await sleep(500);
  await c.settle();
}
SHOTS.remote = async (c) => {
  await openSettings(c, "Remote");
  await dismissToasts(c);
};
SHOTS.remote.meta = { query: "remote=on" };
SHOTS.about = async (c) => {
  await dismissToasts(c);
  await c.clickEl("button", "About IntelyIDE");
  await sleep(600);
};
SHOTS.providers = async (c) => {
  await openSettings(c, "Providers");
  // Experimental providers switch on: the Codex, Gemini, Copilot, ... cards appear.
  await c.eval(`document.querySelector(".pexp").scrollIntoView({ block: "center" })`);
  await c.clickEl(".pexp [role=switch], .pexp input[type=checkbox], .pexp button");
  await waitText(c, "Codex", 15000);
  await sleep(600);
  await c.eval(`document.querySelector(".pexp").scrollIntoView({ block: "start" })`);
  await c.settle();
  await dismissToasts(c);
};

/** Runs a command through the command palette (Cmd+Shift+P), picking the first hit. */
async function palette(c, query) {
  await c.key("P", { code: "KeyP", vk: 80, modifiers: mod.meta | mod.shift });
  await sleep(400);
  await c.type(query);
  await sleep(500);
  await c.key("Enter", { code: "Enter", vk: 13, text: "\r" });
  await c.settle();
}
SHOTS["api-contract"] = async (c) => {
  await dismissToasts(c);
  await palette(c, "API contract");
  await waitText(c, "Findings");
  await dismissToasts(c);
};

SHOTS["api-explorer"] = async (c) => {
  await dismissToasts(c);
  await palette(c, "API contract");
  await waitText(c, "Findings");
  await clickText(c, "Explorer", ".ui-seg, [role=tablist], main, body");
  await clickText(c, "/api/customers/{customerId}");
  await sleep(800);
  await dismissToasts(c);
};
SHOTS["mongo-studio"] = async (c) => {
  await dismissToasts(c);
  await clickRail(c, "Database");
  await clickText(c, "Local fixture", "[class*=mongo], body");
  await waitText(c, "intely_test_shop");
  await clickText(c, "orders", "[role=tree], body");
  await waitText(c, "Read-only");
  await waitText(c, "Table");
  await c.clickEl('input[placeholder*="orders from"], input[placeholder*="Open orders"], textarea[placeholder*="Open orders"]');
  await c.type("paid orders over 200 EUR from the last 7 days");
  await c.key("Enter", { code: "Enter", vk: 13, text: "\r" });
  await waitText(c, "Send this");
  await c.clickEl("button", "Send this");
  await sleep(2500);
  await c.settle();
  await dismissToasts(c);
};
/** Split diff of a changed file above the branch graph, one commit's detail open (the Log is a dock under the editor). */
SHOTS["diff-graph"] = async (c) => {
  await dismissToasts(c);
  await clickRow(c, "OrdersTable.tsx");
  await c.clickEl(".ui-seg__item", "Split");
  await clickRail(c, "Log");
  await waitText(c, "Merge branch");
  await clickText(c, "Fix rounding in totals", ".glog__list");
  await waitText(c, "Cherry-pick");
  await dismissToasts(c);
};
/** The command palette, open over the Changes view. */
SHOTS.palette = async (c) => {
  await dismissToasts(c);
  await clickRow(c, "OrdersTable.tsx");
  await c.key("P", { code: "KeyP", vk: 80, modifiers: mod.meta | mod.shift });
  await sleep(400);
  await c.type("commit");
  await sleep(700);
  await c.settle();
  await dismissToasts(c);
};
SHOTS.appearance = async (c) => {
  await openSettings(c, "Appearance");
  await dismissToasts(c);
};
SHOTS["workspaces-welcome"] = async (c) => {
  await dismissToasts(c);
};
SHOTS["workspaces-welcome"].meta = { scenario: "showcase-welcome" };

// ---------- runner -----------------------------------------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
const todo = names.length ? names : Object.keys(SHOTS);
let failed = 0;
for (const name of todo) {
  if (!SHOTS[name]) { console.error(`unknown shot ${name}`); failed++; continue; }
  for (const theme of THEMES) {
    let done = false;
    // A dev server may hot-reload the page mid-run (another editor session): retry the whole shot from a clean browser.
    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      const c = await launchChrome({ dsf: DSF });
      try {
        const meta = SHOTS[name].meta ?? {};
        await open(c, { query: meta.query ?? "", theme, scenario: meta.scenario });
        await SHOTS[name](c, theme);
        await c.settle(300);
        const file = join(OUT, QUICK ? `${name}-${theme}.png` : `${name}-${theme}-2880.png`);
        await c.shot(file, { f: DSF });
        console.log(`ok   ${name} ${theme} -> ${file}`);
        done = true;
      } catch (e) {
        console.error(`retry ${name} ${theme} (${attempt}): ${e.message}`);
      } finally {
        await c.close();
      }
    }
    if (!done) failed++;
  }
}
demoServer?.close();
process.exit(failed ? 1 : 0);
