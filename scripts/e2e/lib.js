// Shared helpers of the e2e scenarios. run.sh concatenates `config.js` (generated), this file and one scenario into
// the file INTELY_E2E_SCRIPT points at; the app wraps it in an async function that runs after the page loaded, so
// `await` and top-level `const`s are fine here. Scenarios drive the REAL UI through the DOM and end with `await finish()`.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// rAF does not fire in an occluded window, so never wait on it alone.
const frame = () => new Promise((r) => { requestAnimationFrame(() => r()); setTimeout(r, 60); });
const q = (sel, root = document) => root.querySelector(sel);
const qa = (sel, root = document) => [...root.querySelectorAll(sel)];
const text = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

// Reload-aware scenarios (workspace switches reload the page, (design notes: workspaces-spec) 9.4a): checks, notes and page errors survive in
// sessionStorage.__e2e_state = { phase, checks, notes, pageErrors }. A scenario reloads on purpose with `reloadInto(n)` (or `expectReload()`
// before an action that reloads); every other page reload still fails the run loudly.
const E2E_STATE_KEY = "__e2e_state";
const E2E_EXPECT_KEY = "__e2e_expect_reload";
const restoredState = (() => { try { return JSON.parse(sessionStorage.getItem(E2E_STATE_KEY) || "null"); } catch { return null; } })();
const checks = restoredState?.checks ?? [];
const notes = restoredState?.notes ?? {};
let currentPhase = restoredState?.phase ?? 0;
// The injected script runs on EVERY page load. A debug build without the custom-protocol feature serves the UI from the Vite dev server (:1420), which
// does a full page reload whenever anyone edits a ui/ file; the scenario would silently restart against a half-finished app state. Fail loudly instead.
// A reload the scenario asked for (`expectReload`) is accepted exactly once.
try {
  const starts = Number(sessionStorage.getItem("__e2e_starts") || 0) + 1;
  sessionStorage.setItem("__e2e_starts", String(starts));
  if (starts > 1) {
    if (sessionStorage.getItem(E2E_EXPECT_KEY) === "1") {
      sessionStorage.removeItem(E2E_EXPECT_KEY);
      window.__e2e && (window.__e2e.reloaded = true);
    } else {
      await failWith(new Error(`the page reloaded while the scenario ran (script start #${starts}, navigation "${performance.getEntriesByType("navigation")[0]?.type}", ${location.origin}): a Vite dev-server full reload after someone edited ui/ is the usual cause; run e2e against a build with --features custom-protocol (embedded ui/dist)`));
      await new Promise(() => {});
    }
  }
} catch (e) { if (e && /page reloaded/.test(e.message)) throw e; }
const pageErrors = restoredState?.pageErrors ?? [];
// "ResizeObserver loop completed with undelivered notifications" is a benign browser notice (a layout settled over two frames), not a script error.
window.addEventListener("error", (e) => !/^ResizeObserver loop/.test(e.message) && pageErrors.push(`error: ${e.message}`));
window.addEventListener("unhandledrejection", (e) => pageErrors.push(`rejection: ${e.reason?.message ?? e.reason}`));
window.addEventListener("securitypolicyviolation", (e) => pageErrors.push(`csp: ${e.violatedDirective} ${e.blockedURI}`));

function saveE2eState() {
  try { sessionStorage.setItem(E2E_STATE_KEY, JSON.stringify({ phase: currentPhase, checks, notes, pageErrors })); } catch { /* storage blocked: the scenario cannot survive a reload */ }
}
/** Says the next page load is part of the scenario (an action that makes the app reload the webview). */
function expectReload() {
  saveE2eState();
  sessionStorage.setItem(E2E_EXPECT_KEY, "1");
}
/** Runs `fn` only when the scenario is in phase `n`; code outside `phase()` must be idempotent (reads only). */
async function phase(n, fn) {
  if (currentPhase !== n) return false;
  notes.phase = n;
  await fn();
  return true;
}
/** Moves to phase `n` and reloads the page; the returned promise never settles (the script restarts from line 1). */
async function reloadInto(n) {
  currentPhase = n;
  expectReload();
  location.reload();
  await new Promise(() => {});
}

function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail === undefined ? undefined : String(detail) });
  return !!ok;
}

/** Polls `fn` until it returns something truthy; throws with `what` on timeout. */
async function waitFor(fn, { timeout = 20000, what = "condition", interval = 40 } = {}) {
  const t0 = performance.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (performance.now() - t0 > timeout) throw new Error(`timeout (${timeout} ms) waiting for ${what}`);
    await sleep(interval);
  }
}

/** The scrollable ancestor of the (virtualised) changes tree. */
function scroller() {
  let el = q('[role="tree"][aria-label="Changes"]');
  while (el && el !== document.body) {
    const style = getComputedStyle(el);
    if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) return el;
    el = el.parentElement;
  }
  return null;
}

/** Finds a row of the virtualised tree by CSS selector, scrolling the list until it is rendered (null if absent). */
async function findRow(selector) {
  const sc = scroller();
  if (!sc) return q(selector);
  sc.scrollTop = 0;
  for (let i = 0; i < 200; i++) {
    await frame();
    await sleep(15);
    const el = q(selector);
    if (el) return el;
    if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1) return null;
    sc.scrollTop += Math.max(60, sc.clientHeight * 0.7);
  }
  return null;
}

const repoRowSel = (id) => `[data-row="repo"][data-repo="${id}"]`;
const fileRowSel = (id, path) => `[data-row="file"][data-repo="${id}"][data-path="${CSS.escape(path)}"]`;
const dirRowSel = (id, path) => `[data-row="dir"][data-repo="${id}"][data-path="${CSS.escape(path)}"]`;
const unversionedSel = (id) => `[data-row="unversioned"][data-repo="${id}"]`;

/** Rows of the file kind also exist for untracked files below a folder: they are `data-row="file"` as well. */
const tick = (row) => row?.getAttribute("aria-checked"); // "true" | "false" | "mixed"
const rowBox = (row) => q('input[type="checkbox"]', row);

/**
 * Clicks the row's checkbox (the real input, like a user click) and waits for it to show `want` ("true" | "false" | "mixed").
 * Some boxes list files first (folders, Unversioned), so a second click only happens when nothing changed after 3 s.
 */
async function setTick(selector, want, what = selector) {
  const current = async () => tick(await findRow(selector));
  await waitFor(() => findRow(selector), { what: `row ${what}` });
  for (let i = 0; i < 3 && (await current()) !== want; i++) {
    rowBox(await findRow(selector)).click();
    const changed = await waitFor(async () => (await current()) === want, { what: `${what} to be ticked=${want}`, timeout: 3000 }).catch(() => false);
    if (changed) return;
  }
  await waitFor(async () => (await current()) === want, { what: `${what} to be ticked=${want}`, timeout: 5000 });
}

async function expandRow(selector) {
  const row = await waitFor(() => findRow(selector), { what: `row ${selector}` });
  if (row.getAttribute("aria-expanded") === "false") q(".ui-tree-row__chevron", row).click();
  await waitFor(async () => (await findRow(selector))?.getAttribute("aria-expanded") === "true", { what: "row to expand" });
}

/** Sets the value of an input/textarea the way typing does, so the framework's input handlers run. */
async function typeInto(el, value) {
  el.focus();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
  await sleep(60);
}

const buttons = (root = document) => qa("button", root);
const findButton = (label, root = document) => buttons(root).find((b) => text(b) === label || b.getAttribute("aria-label") === label);
async function clickButton(label, root = document, what = label) {
  if (!root) throw new Error(`no container to look for the button "${what}" in`);
  const b = await waitFor(() => {
    const found = findButton(label, root);
    return found && !found.disabled && found.getAttribute("aria-disabled") !== "true" ? found : null;
  }, { what: `enabled button "${what}"` });
  b.click();
  await sleep(60);
}

async function chooseMenuItem(triggerLabel, itemLabel, root = document) {
  await clickButton(triggerLabel, root);
  const item = await waitFor(() => qa('[role="menuitem"]').find((i) => text(i).startsWith(itemLabel)), { what: `menu item "${itemLabel}"` });
  item.click();
  await sleep(80);
}

/** The commit panel's main button ("Commit (2 repos, 9 files)"). */
const commitButton = () => q(".commit-panel__actions .ui-split > button");
const sheet = () => q("section.results-sheet");
/** `{ "shop-backend": "Done", ... }` from the results sheet. */
function sheetRows() {
  const out = {};
  for (const li of qa("li.results-row", sheet() ?? document)) {
    const m = /^(.*): ([^:]+)$/.exec(li.getAttribute("aria-label") ?? "");
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const sheetRow = (name) => qa("li.results-row", sheet() ?? document).find((li) => (li.getAttribute("aria-label") ?? "").startsWith(`${name}:`));

async function sharedMessage(message) {
  await typeInto(await waitFor(() => q('textarea[aria-label="Commit message"]'), { what: "shared message field" }), message);
}

async function useMode(label) {
  const radio = qa('[role="radiogroup"][aria-label="Message mode"] [role="radio"]').find((r) => text(r) === label);
  if (!radio) throw new Error(`no message mode "${label}"`);
  if (radio.getAttribute("aria-checked") !== "true") radio.click();
  await waitFor(() => radio.getAttribute("aria-checked") === "true", { what: `mode ${label}` });
  await sleep(100);
}

async function untickRepo(id) {
  await setTick(repoRowSel(id), "false", `repo ${id}`);
}

/** Waits until the engine delivered a snapshot for every repo (the repo rows show their counts). */
async function waitForTree() {
  for (const id of FX.repoIds) {
    await waitFor(async () => {
      const row = await findRow(repoRowSel(id));
      if (!row) return false;
      if (q(".chg-count", row)) return true;
      // a clean repo shows no count: then the engine's snapshot says there is nothing to count
      const snap = await invoke("snapshot_get", { repoId: id }).catch(() => null);
      return !!snap && !snap.error && snap.changes.length === 0;
    }, { what: `change count of ${id}`, timeout: 30000 });
  }
}

/** A section the build under test cannot run yet: recorded in the report, never a failure. */
function skip(name, reason) {
  (notes.skipped ??= []).push(`${name}: ${reason}`);
}

const KEY_CODES = { Enter: "Enter", Escape: "Escape", " ": "Space", Tab: "Tab", ArrowDown: "ArrowDown", ArrowUp: "ArrowUp", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", Home: "Home", End: "End" };

/**
 * Dispatches a key press (keydown, keyup) on `target` (default: the focused element) with the modifiers in `mods`
 * (`{ meta, alt, shift, ctrl }`). The events are untrusted: the page's own handlers run, but the browser's default
 * actions (Tab moving focus, Space clicking a button) do not. Returns the keydown event (`defaultPrevented`).
 */
async function press(key, mods = {}, target = document.activeElement ?? document.body) {
  const init = {
    key, code: KEY_CODES[key] ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key), bubbles: true, cancelable: true, composed: true,
    metaKey: !!mods.meta, altKey: !!mods.alt, shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl,
  };
  const down = new KeyboardEvent("keydown", init);
  target.dispatchEvent(down);
  target.dispatchEvent(new KeyboardEvent("keyup", init));
  await sleep(80);
  return down;
}

const changesTree = () => q('[role="tree"][aria-label="Changes"]');
/** The row the keyboard cursor (aria-activedescendant) is on. */
const cursorRow = () => {
  const id = changesTree()?.getAttribute("aria-activedescendant");
  return id ? document.getElementById(id) : null;
};
const describeRow = (row) => (row ? `${row.getAttribute("data-row")}:${row.getAttribute("data-path") ?? row.getAttribute("data-repo")}` : "none");
const pushDialog = () => qa('[role="dialog"]').find((d) => q('[role="tree"][aria-label="Repositories and outgoing commits"]', d));
const textarea = () => q('textarea[aria-label="Commit message"]');
/** `{ repo: "Done" | ... }` once no row is queued or running. */
const sheetSettled = () => sheet() && Object.keys(sheetRows()).length > 0 && !/Queued|ing\b/.test(Object.values(sheetRows()).join(" "));

/** Closes the results sheet with its close button (the sheet is not modal and ignores Escape). */
async function closeResults() {
  const b = sheet() && findButton("Close results", sheet());
  if (b) b.click();
  await waitFor(() => !sheet(), { what: "results sheet to close", timeout: 5000 });
}

/** The Theme menu of the title bar, driven like a user (the trigger's label says which preference is active). */
async function chooseTheme(label) {
  const trigger = await waitFor(() => qa("button").find((b) => /^Theme:/.test(b.getAttribute("aria-label") ?? "")), { what: "theme button" });
  trigger.click();
  const item = await waitFor(() => qa('[role^="menuitem"]').find((i) => text(i) === label), { what: `theme item ${label}` });
  item.click();
  await sleep(150);
}
let calmSheet;
/** Turns CSS transitions and animations off (a constructed sheet: the CSP forbids inline <style>). A colour read right after a theme switch is then final, also when the window is covered and the page gets no animation frames. */
function calmMotion(on = true) {
  if (!calmSheet) {
    calmSheet = new CSSStyleSheet();
    calmSheet.replaceSync("*, *::before, *::after { transition: none !important; animation: none !important; }");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, calmSheet];
  }
  calmSheet.disabled = !on;
}
const themeState = () => ({
  theme: document.documentElement.getAttribute("data-theme"),
  pref: document.documentElement.getAttribute("data-theme-pref"),
  stored: (() => { try { return localStorage.getItem("intely.theme"); } catch { return "unavailable"; } })(),
  bg: getComputedStyle(document.body).backgroundColor,
});

// `window.__e2e_invoke` is only set by the browser dry run of the scenarios (.scratch/pw); the app always uses the Tauri bridge.
const invoke = (command, args) => (window.__e2e_invoke ?? window.__TAURI_INTERNALS__.invoke)(command, args);

// The app's window is hidden while a scenario runs, and WebKit suspends a hidden page after a few quiet seconds: its timers and IPC stop, nothing reports,
// and the run ends as "e2e timeout" (m, mcs, zz and pm stalled that way). A tiny snapshot every second is work driven from the host, which keeps the page
// running. All shots go through one queue so the heartbeat never overlaps a scenario's own; run.sh deletes the <scenario>-hb-*.png files afterwards.
if (!window.__e2e_invoke && window.__e2e && !window.__e2eKeepAlive) {
  window.__e2eKeepAlive = true;
  const rawShot = window.__e2e.screenshot.bind(window.__e2e);
  let shotQueue = Promise.resolve();
  let beating = false;
  window.__e2e.screenshot = (name, scale) => { const run = () => rawShot(name, scale); return (shotQueue = shotQueue.then(run, run)); };
  setInterval(() => {
    if (window.__e2eFinished || beating) return;
    beating = true;
    void window.__e2e.screenshot("hb", 0.1).catch(() => {}).finally(() => { beating = false; });
  }, 1000);
}

// A scenario that stalls (a promise that never settles) must still report the DOM and the last step before the app's own watchdog.
setTimeout(() => { if (!window.__e2eFinished) void failWith(new Error(`scenario stalled (watchdog)${notes.step ? ` after step "${notes.step}"` : ""}`)); }, typeof SCENARIO_TIMEOUT_MS === "number" ? SCENARIO_TIMEOUT_MS : 140000);
const step = (name) => { notes.step = name; };

async function finish(extra) {
  window.__e2eFinished = true;
  try { sessionStorage.removeItem(E2E_STATE_KEY); sessionStorage.removeItem(E2E_EXPECT_KEY); } catch { /* ignore */ }
  Object.assign(notes, extra ?? {});
  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
  const ok = checks.every((c) => c.ok);
  await invoke("e2e_report", { ok, report: { checks, notes, pageErrors } });
}

/** Reports an exception of the scenario together with what the page showed, then ends the run as failed. */
async function failWith(e) {
  const dom = (document.body.innerText || "").replace(/\n+/g, " | ").slice(0, 2500);
  // a picture of the failure next to the other shots (INTELY_E2E_SHOTS), best effort
  try { await Promise.race([window.__e2e.screenshot(`failure-${String(notes.step || "start").replace(/[^a-z0-9]+/gi, "-")}`), sleep(8000)]); } catch { /* the report matters more */ }
  await invoke("e2e_report", {
    ok: false,
    report: { checks, notes, pageErrors, error: String((e && e.message) || e), stack: String((e && e.stack) || ""), dom },
  });
}
