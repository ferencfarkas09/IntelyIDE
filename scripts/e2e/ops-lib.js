// Helpers of the click-through scenarios o..w (run.sh appends this file after lib.js for them). They drive the REAL UI the
// way a user does: palette commands, rail buttons, context menus, dialogs, toasts. Setup that is not under test goes
// through `invoke` (the same IPC the UI uses).
const BACKEND = "shop-backend";
const dialogsOpen = () => qa('[role="dialog"], [role="alertdialog"]');
const railButton = (title) => qa("nav.rail button").find((b) => (b.getAttribute("aria-label") ?? "").startsWith(title));
const toastList = () => qa(".ui-toast").map((t) => ({ tone: t.getAttribute("role") === "alert" ? "danger" : "other", title: text(q(".ui-toast__title", t)), desc: text(q(".ui-toast__desc", t)), el: t }));
const toastText = () => toastList().map((t) => `${t.title} ${t.desc}`).join(" | ");
const waitToast = (re, what = String(re), timeout = 15000) => waitFor(() => toastList().find((t) => re.test(`${t.title} ${t.desc}`)), { what: `toast ${what}`, timeout });

/** Runs a command from the palette (Cmd+Shift+P, type, Enter) like a user. */
async function runCommand(title) {
  await press("p", { meta: true, shift: true });
  const palette = await waitFor(() => q(".palette"), { what: "the command palette" });
  const field = await waitFor(() => q('[role="combobox"]', palette), { what: "the palette field" });
  await typeInto(field, title);
  await waitFor(() => qa('[role="option"]', palette).some((o) => text(o).toLowerCase().startsWith(title.toLowerCase())), { what: `palette entry "${title}"`, timeout: 8000 });
  const first = qa('[role="option"]', palette).find((o) => text(o).toLowerCase().startsWith(title.toLowerCase()));
  first.click();
  await sleep(150);
}

/** Opens a rail tool window (Project, Log, Search, Terminal...). */
async function openRail(title) {
  const b = await waitFor(() => railButton(title), { what: `rail button ${title}` });
  if (b.getAttribute("aria-pressed") !== "true") b.click();
  await sleep(150);
}

/** A right click at the middle of `el`, which opens the context menu there. */
function rightClick(el) {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + r.height / 2, button: 2 }));
}
async function chooseContext(elOrFn, label) {
  // the tree re-renders rows after every change: look the element up again right before the click
  const el = typeof elOrFn === "function" ? await waitFor(() => elOrFn(), { what: "the row to right-click", timeout: 8000 }) : elOrFn;
  rightClick(el);
  const item = await waitFor(() => qa('[role^="menuitem"]').find((i) => text(i).startsWith(label)), { what: `context menu item "${label}"`, timeout: 5000 });
  item.click();
  await sleep(120);
}

/** The top dialog (the last one in the DOM) with `re` in its title. */
const dialogWith = (re) => dialogsOpen().find((d) => re.test(text(q("h2, [id$='title'], header", d) ?? d)) || re.test(text(d).slice(0, 200)));
const waitDialog = (re, what = String(re), timeout = 10000) => waitFor(() => dialogWith(re), { what: `dialog ${what}`, timeout });
const dialogGone = (d, timeout = 10000) => waitFor(() => !d.isConnected, { what: "the dialog to close", timeout });

/** A tree item by its visible name (the row's main label), inside `root`. */
const treeItem = (name, root = document) => qa('[role="treeitem"]', root).find((i) => text(q(".ui-tree-row__main", i) ?? i) === name);
const waitTreeItem = (name, root = document, timeout = 15000) => waitFor(() => treeItem(name, root), { what: `tree item "${name}"`, timeout });

/** Types a name into the open prompt dialog and confirms with the dialog's own button. */
async function answerPrompt(titleRe, value, confirmLabel) {
  const d = await waitDialog(titleRe, "prompt");
  await typeInto(await waitFor(() => q("input", d), { what: "the prompt field" }), value);
  await clickButton(confirmLabel, d);
  return d;
}

/** Reads the repository list through the engine's workspace (for ids and paths). */
const repoPath = async (id) => (await invoke("workspace_get")).repos.find((r) => r.id === id).path;

/** Light screenshot helper: the app's own WKWebView snapshot (never the desktop). */
async function snap(name) { try { await window.__e2e.screenshot(name); } catch (e) { notes.shotError = String(e); } }

/**
 * Runs one shell command in a terminal the engine opens at the repo root (the same IPC the Terminal panel uses), waits for its
 * end marker and returns the output. For preparation steps the UI offers no button for (staging a resolved conflict).
 */
async function termRun(repoId, command, timeout = 25000) {
  let buf = "";
  const cb = window.__TAURI_INTERNALS__.transformCallback((resp) => {
    const m = resp && typeof resp === "object" && "message" in resp ? resp.message : resp;
    if (m && m.kind === "data") buf += m.data;
  });
  const opened = await invoke("term_open", { opts: { repoId, cols: 120, rows: 30 }, onEvent: `__CHANNEL__:${cb}` });
  const mark = `E2E-DONE-${Math.random().toString(36).slice(2, 8)}`;
  await invoke("term_write", { termId: opened.termId, data: `${command}; echo ${mark}$?\n` });
  const got = await waitFor(() => new RegExp(`${mark}\\d+`).test(buf.replace(new RegExp(`echo ${mark}`), "")) && buf.split(mark).length > 2, { what: `terminal command "${command}"`, timeout });
  await invoke("term_close", { termId: opened.termId });
  return buf;
}

/** requestAnimationFrame never fires in a covered window; xterm's fit and renderer wait on it. Timer-driven frames keep them going (a test-only stand-in). */
function fixRaf() {
  if (window.__rafFixed) return;
  window.__rafFixed = true;
  const orig = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => {
    let done = false;
    const run = (t) => { if (!done) { done = true; cb(t); } };
    orig(run);
    return setTimeout(() => run(performance.now()), 32);
  };
}
