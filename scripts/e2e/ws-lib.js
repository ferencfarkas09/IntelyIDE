// Helpers of the workspace scenarios (wsa .. wsh, (design notes: workspaces-spec) 9.4). run.sh appends ops-lib.js and then this file after lib.js
// (`extra_lib` for the ids ws*); the dialog, toast, rail and screenshot helpers (waitDialog, toastText, openRail, snap ...) come from ops-lib.js.
// Like lib.js this drives the REAL UI through the DOM; the registry itself is only READ (through the IPC) to assert state.
//
// What the scenarios expect from the fixture (scripts/make-fixture-registry.sh, owner C6; INTELY_WORKSPACES=$FX/state/workspaces.json,
// INTELY_E2E=1, INTELY_FIXTURE_ROOT=$FX, INTELY_PICK_SCRIPT=$FX/pick.jsonl):
//   repos            $FX/repos/{shop-backend, admin, shop-mobile, shop-pos} (make-fixture-workspace.sh)
//   wsa              no registry file and no legacy file
//   wsb, wsb2        no registry file, a legacy $FX/state/workspace.json with the four repos, a push target and a live branch
//   wsc, wsc2, wsd,  registry with "Alpha" (id w-alpha: shop-backend + admin, active), "Beta" (id w-beta: shop-mobile +
//   wsf, wsf2, wsg   shop-pos) and "Gamma" (id w-gamma: admin alone)
//   wse              Alpha active, plus $FX/scan/ with three repositories, a node_modules decoy, a symlink and a nested repository
//   pick.jsonl       one JSON line per native pick, in the order the scenario asks (see the header of each scenario)
const REPO_DIR = { backend: "shop-backend", admin: "admin", services: "shop-mobile", pos: "shop-pos" };
const wsRepoPath = (key) => `${FX.root}/repos/${REPO_DIR[key]}`;

const welcomeEl = () => q('[data-testid="welcome"]');
const shellEl = () => q(".shell__body");
const switcherEl = () => q("button.switcher");
const switcherLabel = () => switcherEl()?.getAttribute("aria-label") ?? "";
const workspacesView = () => invoke("workspaces_list");
const recentItems = () => qa(".recent__item");
const recentNamed = (name) => recentItems().find((li) => text(q(".recent__name", li)) === name);

const waitWelcome = () => waitFor(() => welcomeEl(), { what: "the Welcome screen", timeout: 30000 });
const waitShell = () => waitFor(() => shellEl() && !q(".splash"), { what: "the workspace shell", timeout: 30000 });

/** Clicks something that makes the app reload the webview, and waits for that reload (the script restarts in phase `n`). */
async function actReloadInto(n, action, what = "the page to reload") {
  currentPhase = n;
  expectReload();
  await action();
  await sleep(25000);
  throw new Error(`timeout (25000 ms) waiting for ${what}`);
}

async function openSwitcher() {
  const trigger = await waitFor(() => switcherEl(), { what: "the workspace switcher" });
  if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
  await waitFor(() => qa('[role="menuitem"], [role="menuitemradio"]').length > 0, { what: "the switcher menu" });
}
const menuItem = (label) => qa('[role="menuitem"], [role="menuitemradio"]').find((i) => text(i).startsWith(label));
async function chooseSwitcherItem(label) {
  await openSwitcher();
  const item = await waitFor(() => menuItem(label), { what: `switcher item "${label}"` });
  item.click();
  await sleep(120);
}

/** The picker dialog, when one is open (its title is "Choose a folder", "Choose folders" ...). */
const pickerDialog = () => qa('[role="dialog"]').find((d) => /Choose|folder|Finder/i.test(text(q(".ui-dialog__title", d))));

/**
 * Answers the folder picker: the native tab waits for "Choose in Finder..." (the fake picker then answers from pick.jsonl at once); a
 * review card (trust, subfolder, not a repository) is confirmed with its primary button. Returns false when no picker opened.
 */
async function confirmPickerIfShown(labels = ["Choose this folder", "Use this folder", "Use the repository root", "Add", "Choose"]) {
  const dialog = await waitFor(() => pickerDialog(), { timeout: 2500, what: "picker dialog" }).catch(() => null);
  if (!dialog) return false;
  const native = await waitFor(() => findButton("Choose in Finder...", dialog), { timeout: 1500, what: "Choose in Finder button" }).catch(() => null);
  if (native) {
    native.click();
    await sleep(300);
  }
  for (let i = 0; i < 20 && document.contains(dialog); i++) {
    // the fixture repositories carry an executable hook: the trust card wants its tick before the primary button works
    for (const box of qa('input[type="checkbox"]', dialog)) if (/trust this repository/i.test(text(box.closest("label") ?? box.parentElement)) && !box.checked) box.click();
    const button = qa("button", dialog).find((b) => !b.disabled && labels.some((l) => text(b) === l || text(b).startsWith(`${l} (`)));
    if (button) {
      button.click();
      await sleep(150);
      return true;
    }
    await sleep(150);
  }
  return true;
}

/** Runs a registered command through the palette-free path: the real keyboard chord of the command. */
async function chord(key, mods) {
  await press(key, mods, document.body);
}

/** The repo rows the Changes tree shows, by display name. */
const treeRepoNames = () => qa('[data-row="repo"]').map((r) => text(q(".chg-repo__name, .ui-tree-row__label", r)) || r.getAttribute("data-repo"));
const treeRepoIds = () => qa('[data-row="repo"]').map((r) => r.getAttribute("data-repo"));

/** The registry as the app sees it: `{ names, activeId, byId }`. */
async function registrySummary() {
  const v = await workspacesView();
  return { activeId: v.activeId, names: v.workspaces.map((w) => w.name), byId: Object.fromEntries(v.workspaces.map((w) => [w.id, w])), view: v };
}

/** A real-looking drop: the E2E-gated command validates the folders like Rust does for a window drop and fills the inbox. */
const dropFolders = (paths) => invoke("e2e_drop", { paths });
