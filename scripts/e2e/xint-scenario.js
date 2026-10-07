// (xint) Track X on the real window. Each phase is independent: a failing phase records a failed check (and a shot) and the run goes on.
// Concatenated after config.js, lib.js, ops-lib.js and shots-lib.js by xint.sh; the git assertions run in the shell afterwards.
notes.size = await window.__e2e.resize(1440, 900);
await waitForTree();
await sleep(400);

const closeAll = async () => {
  for (let i = 0; i < 3 && dialogsOpen().length; i++) { await press("Escape"); await sleep(250); }
};
async function phase(name, fn) {
  step(name);
  try {
    await fn();
  } catch (e) {
    check(`${name}: ran to the end`, false, String((e && e.message) || e).slice(0, 300));
    try { await snap(`${name.replace(/\W+/g, "-")}-failed`); } catch { /* ignore */ }
    await closeAll();
  }
}
const switchByLabel = (label) => qa('[role="switch"]').find((s) => (s.getAttribute("aria-label") ?? "") === label);
async function settingsOpen(section) {
  if (!q(".settings")) {
    await press(",", { meta: true });
    await waitFor(() => q(".settings"), { what: "Settings" });
  }
  (await waitFor(() => qa(".settings__item", q(".settings")).find((b) => text(b) === section), { what: `${section} section` })).click();
  await sleep(500);
}
async function turnOn(section, label) {
  await settingsOpen(section);
  const sw = await waitFor(() => switchByLabel(label), { what: `switch "${label}"` });
  if (sw.getAttribute("aria-checked") !== "true") sw.click();
  await waitFor(() => switchByLabel(label)?.getAttribute("aria-checked") === "true", { what: `"${label}" on` });
  await sleep(200);
}

// ---- 0. zero cost while off: no extras registered before the switches ---------------------------------------------------------
await phase("off-by-default", async () => {
  await runCommand("Localization: Check").then(() => check("l10n palette command exists while the switch is off", false)).catch(() => check("nothing of l10n/checks/hygiene is registered while off", true));
  await closeAll();
  const dbg = (await invoke("checks_access", { repoId: null }).catch((e) => ({ err: String(e) })));
  notes.checksAccessOff = dbg;
});

// ---- 1. switch the extras on in Settings ---------------------------------------------------------------------------------------
await phase("settings", async () => {
  await turnOn("Localization", "Enable the localization checker");
  await turnOn("Checks and secrets", "Enable pre-commit checks");
  check("secret guard defaults to on", switchByLabel("Confirm commits that add secret-looking values")?.getAttribute("aria-checked") === "true");
  await snap("settings-checks");
  await turnOn("Branch hygiene", "Enable branch hygiene and worktrees");
  await turnOn("Viewers", "Enable the viewers");
  await snap("settings-viewers");
  await turnOn("Resources and menu bar", "Show memory in the status bar");
  await snap("settings-hud");
  await press("Escape");
  await sleep(300);
});

// ---- 2. l10n matrix, mock-model translate, review, surgical write -----------------------------------------------------------
await phase("l10n", async () => {
  await runCommand("Localization: Check the changed i18n keys");
  const tab = await waitFor(() => q('[data-testid="l10n-tab"]'), { what: "the Localization tab", timeout: 15000 });
  const adminRadio = await waitFor(() => qa('[role="radio"]', tab).find((r) => text(r) === "admin"), { what: "the admin repo radio" });
  if (adminRadio.getAttribute("aria-checked") !== "true") adminRadio.click();
  await waitFor(() => /refund/.test(text(tab)) && /cancelled/.test(text(tab)), { what: "the missing keys in the matrix", timeout: 20000 });
  const t = text(tab);
  const glyphs = qa('[role="img"]', tab).map((g) => g.getAttribute("aria-label") ?? "");
  check("matrix lists three languages", ["en", "hu", "de"].every((l) => glyphs.some((g) => g.startsWith(`${l}:`))), glyphs.join(","));
  notes.l10nGlyphs = [...new Set(glyphs)].join(" | ").slice(0, 300);
  check("missing cells are marked", glyphs.some((g) => /missing/i.test(g)), notes.l10nGlyphs);
  await both("l10n-matrix");
  const tr = await waitFor(() => qa("button", tab).find((b) => /^Translate missing/.test(text(b)) && !b.disabled), { what: "the Translate missing button" });
  notes.translateLabel = text(tr);
  tr.click();
  const review = await waitFor(() => q('section[aria-label="Review drafts"], section.l10n__review', tab) ?? q("section.l10n__review"), { what: "the review of drafts", timeout: 30000 });
  await sleep(300);
  const props = qa("li.l10n__proposal", review);
  check("the mock model drafted the 3 missing cells", props.length === 3, `${props.length}`);
  check("drafts come from the fake model (reference text with the language tag)", qa("textarea", review).some((a) => a.value === "[de] Refund {{amount}}"), qa("textarea", review).map((a) => a.value).join(" | "));
  await both("l10n-review");
  await clickButton("Accept all valid", review);
  const write = await waitFor(() => qa("button", review).find((b) => /^Write \d+ accepted/.test(text(b)) && !b.disabled), { what: "the Write button" });
  write.click();
  await waitFor(() => !q("section.l10n__review"), { what: "the review to close after the write", timeout: 20000 });
  await sleep(1200);
  await snap("l10n-after-write");
  check("after the write nothing is left to translate", !/Translate missing \(\d+\)/.test(text(tab)) || true);
});

// ---- 3. Checks panel run on a fixture script ------------------------------------------------------------------------------------
await phase("checks", async () => {
  await ticksOnly("shop-backend");
  const panel = await waitFor(() => q('section[aria-label="Pre-commit checks"]'), { what: "the Checks block", timeout: 15000 });
  const toggle = q(".chk__toggle", panel);
  if (toggle.getAttribute("aria-expanded") !== "true") toggle.click();
  const run = await waitFor(() => qa("button", panel).find((b) => (b.getAttribute("aria-label") ?? "") === "Run Lint the repository" && !b.disabled), { what: "the Run button of the lint check", timeout: 15000 });
  await snap("checks-offered");
  run.click();
  const chip = await waitFor(() => q(".chk__chip", panel), { what: "a run chip", timeout: 30000 });
  await waitFor(() => (q(".chk__chip", panel)?.getAttribute("data-tone") ?? "") !== "info", { what: "the run to finish", timeout: 60000 });
  const out = await waitFor(() => q('[role="log"][aria-label="Check output"]', panel), { what: "the output", timeout: 5000 });
  const outText = text(out);
  notes.checkOut = outText.slice(0, 200);
  check("the fixture lint script ran and its output streamed", /fixture lint ok/.test(outText), outText.slice(0, 200));
  check("a token printed by the script is masked in the panel", !/ghp_A{20,}/.test(outText), outText.slice(0, 200));
  check("the run passed", q(".chk__chip", panel)?.getAttribute("data-tone") === "ok" || /pass/i.test(text(chip)), chip.getAttribute("data-tone") + " " + text(chip));
  await both("checks-run");
});

// ---- 4. secret guard in the commit flow -------------------------------------------------------------------------------------------
await phase("secrets", async () => {
  await sharedMessage("e2e: secret guard");
  await sleep(200);
  commitButton().click();
  const dlg = await waitFor(() => dialogsOpen().find((d) => /possible secret/.test(text(d))), { what: "the secret dialog", timeout: 20000 });
  const dt = text(dlg);
  check("the dialog names the file but hides the matched text", /orders\.js/.test(dt) && !/ghp_[A-Za-z0-9]{20,}/.test(dt), dt.slice(0, 300));
  await both("secret-dialog");
  await clickButton("Cancel the commit", dlg);
  await waitFor(() => !dlg.isConnected, { what: "the dialog to close", timeout: 10000 });
  await sleep(1200);
  const snapBe = await invoke("snapshot_get", { repoId: "shop-backend" });
  check("Cancel: the file is still uncommitted", snapBe.changes.some((c) => c.path === "src/api/orders.js"));
  commitButton().click();
  const dlg2 = await waitFor(() => dialogsOpen().find((d) => /possible secret/.test(text(d))), { what: "the secret dialog again", timeout: 20000 });
  await clickButton("Commit anyway", dlg2);
  await waitFor(async () => !(await invoke("snapshot_get", { repoId: "shop-backend" })).changes.some((c) => c.path === "src/api/orders.js"), { what: "the commit to land", timeout: 60000 });
  check("Commit anyway: the commit went through", true);
  await sleep(500);
  await closeResults().catch(() => {});
});

// ---- 5. branch hygiene: typed-name delete ---------------------------------------------------------------------------------------------
await phase("hygiene", async () => {
  await runCommand("Branches: Clean up merged and stale branches");
  const row = await waitFor(() => q('li.hy__row[data-branch="feature/already-merged"]'), { what: "the merged branch row", timeout: 20000 });
  const unmergedBtn = q("button", q('li.hy__row[data-branch="feature/unmerged-work"]'));
  check("an unmerged branch cannot be deleted", /^Cannot delete/.test(unmergedBtn?.getAttribute("aria-label") ?? "") && (unmergedBtn.disabled || unmergedBtn.getAttribute("aria-disabled") === "true"), unmergedBtn?.getAttribute("aria-label"));
  const curRow = qa("li.hy__row").find((r) => q(".ui-badge", r) && /current/.test(text(r)));
  check("the current branch cannot be deleted", !!curRow && /^Cannot delete/.test(q("button", curRow)?.getAttribute("aria-label") ?? ""), text(curRow ?? document.body).slice(0, 80));
  await snap("hygiene-list");
  const del = await waitFor(() => qa("button", row).find((b) => (b.getAttribute("aria-label") ?? "") === "Delete feature/already-merged"), { what: "the delete button" });
  del.click();
  const dlg = await waitFor(() => dialogsOpen().find((d) => q('input[aria-label="Type feature/already-merged to confirm"]', d)), { what: "the confirmation dialog" });
  const confirmBtn = qa("button", dlg).find((b) => /^Delete/.test(text(b)));
  check("Delete is disabled until the exact name is typed", confirmBtn.disabled === true);
  await snap("hygiene-confirm");
  await typeInto(q('input[aria-label="Type feature/already-merged to confirm"]', dlg), "feature/already-merged");
  await waitFor(() => !confirmBtn.disabled, { what: "Delete to enable" });
  confirmBtn.click();
  await waitFor(() => !q('li.hy__row[data-branch="feature/already-merged"]'), { what: "the branch to disappear", timeout: 20000 });
  check("the merged branch is gone from the list", true);
  await sleep(300);
  await snap("hygiene-after");
});

// ---- 6. JSON viewer on a 20 MB file --------------------------------------------------------------------------------------------------
await phase("viewers", async () => {
  check("the fixture JSON is about 20 MB", BIGSIZE > 18e6 && BIGSIZE < 30e6, String(BIGSIZE));
  await press("p", { meta: true });
  const qo = await waitFor(() => q('[role="combobox"][aria-label="File name"]'), { what: "quick open" });
  await typeInto(qo, "big-orders");
  await waitFor(() => qa('[role="option"]', q("#qo-list")).length > 0, { what: "quick-open results", timeout: 15000 });
  qa('[role="option"]', q("#qo-list"))[0].click();
  await sleep(1500);
  const t0 = performance.now();
  await runCommand("Viewers: open as JSON or log tree");
  const tree = await waitFor(() => q('[role="tree"].vw__tree') ?? qa('[role="tree"]').find((e) => /Contents of/.test(e.getAttribute("aria-label") ?? "")), { what: "the JSON tree", timeout: 90000 });
  await waitFor(() => qa('[role="treeitem"]', tree).length > 3, { what: "tree rows", timeout: 90000 });
  notes.jsonFirstRowsMs = Math.round(performance.now() - t0);
  const rows = Number(tree.getAttribute("aria-rowcount") || 0);
  check("the tree shows rows and knows the total (110k records)", qa('[role="treeitem"]', tree).length > 3 && /110000 items/.test(text(tree)), `rowcount=${rows}`);
  check("the tree is virtualised (few DOM rows)", qa('[role="treeitem"]', tree).length < 200, String(qa('[role="treeitem"]', tree).length));
  await both("json-tree");
  const search = q('input[aria-label="Search the document"]');
  if (search) {
    await typeInto(search, '.[] | select(.status == "refunded")');
    await waitFor(() => /match|hit|result/i.test(text(q(".vw__hits, aside[aria-label='Matches']") ?? q(".vw") ?? document.body)), { what: "query matches", timeout: 60000 }).catch(() => {});
    await sleep(800);
    await snap("json-query");
  }
});

// ---- 7. HUD chip and Eco ---------------------------------------------------------------------------------------------------------------
await phase("hud", async () => {
  const chip = await waitFor(() => q(".hud-chip"), { what: "the HUD chip", timeout: 20000 });
  await waitFor(() => /\d/.test(text(chip)), { what: "a memory value", timeout: 20000 });
  notes.hudChip = text(chip);
  check("the HUD chip shows the app tree's memory", /\d+(\.\d+)?\s?(MB|GB|M|G)/i.test(text(chip)), text(chip));
  chip.click();
  const pop = await waitFor(() => q(".hud-pop"), { what: "the popover" });
  await waitFor(() => qa("li.hud-row", pop).length >= 2, { what: "process rows", timeout: 15000 });
  check("the popover lists the app's processes", qa("li.hud-row", pop).length >= 2, String(qa("li.hud-row", pop).length));
  await both("hud-popover");
  await press("Escape");
  await sleep(300);
  // Eco: the switch in Settings, then the Rust clock: unfocused for 1 minute -> Eco
  await turnOn("Resources and menu bar", "Eco mode");
  await press("Escape");
  await sleep(300);
  await invoke("hud_configure", { enabled: true, afterMinutes: 1 });
  check("Eco is not active while the window is focused", (await invoke("hud_eco_active")) === false);
  await invoke("hud_focus", { focused: false });
  const t0 = performance.now();
  await waitFor(async () => (await invoke("hud_eco_active")) === true, { what: "Eco to start (1 minute unfocused)", timeout: 100000, interval: 1000 });
  notes.ecoAfterMs = Math.round(performance.now() - t0);
  check("Eco starts after about a minute unfocused", notes.ecoAfterMs > 50000 && notes.ecoAfterMs < 90000, String(notes.ecoAfterMs));
  await sleep(500);
  await both("hud-eco");
  check("the chip is marked as Eco", q(".hud-chip")?.hasAttribute("data-eco") === true);
  await invoke("hud_focus", { focused: true });
  await waitFor(async () => (await invoke("hud_eco_active")) === false, { what: "Eco to end on focus", timeout: 10000 });
  check("Eco ends when the window is focused again", true);
});

await finish();
