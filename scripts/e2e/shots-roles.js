// Shot tour of roles and Auto runs ((design notes: roles-orchestration-spec) section 8.5; shots.sh concatenates config.js, lib.js, shots-lib.js and this
// file, on a registry fixture with INTELY_MOCK_PROVIDER=1 and a throwaway CLAUDE_CONFIG_DIR holding researcher.md and writer.md):
//   1. Settings > Roles: one row per name, the copies, the permission in plain words        (roles-list)
//   2. the delete dialog of a role file: paths, backup folder, typed name; nothing is deleted (roles-delete)
//   3. New run in Auto: the summary card with the lead and the roles it hands work to         (new-run-auto)
//   4. a delegating run in the mock provider: role chips with their models                   (run-delegation)
//   5. the Inspector of that run: roles in this run, cost by model                            (inspector-roles)
// English first, then Hungarian (the page reloads); every shot in dark and in light with the app's own e2e_screenshot
// (never a desktop capture). Shots are named roles-<shot>-<en|hu>-<dark|light>.png. The delete dialog is only looked at: the
// typed name is never entered, so no file is touched.
const hasText = (el, re) => re.test(text(el));

async function rolesShots(lang) {
  await window.__e2e.resize(1440, 900);
  await waitFor(() => q(".shell__body") && !q(".splash"), { what: "the workspace shell", timeout: 30000 });
  await sleep(700);

  step(`settings roles ${lang}`);
  await press(",", { meta: true });
  const settings = await waitFor(() => q(".settings"), { what: "Settings" });
  (await waitFor(() => qa(".settings__item", settings).find((b) => /^(Roles|Szerepkörök)$/.test(text(b))), { what: "the Roles section" })).click();
  await waitFor(() => qa("tbody.roles__role").length >= 2 && !q(".roles__loading"), { what: "the roles table", timeout: 20000 });
  await sleep(500);
  const first = qa("tbody.roles__role").find((t) => q(".roles__chevron", t));
  q(".roles__chevron", first).click();
  await waitFor(() => q(".roles__copies", first) || q(".roles__panel", first), { what: "the role details" });
  await sleep(500);
  notes[`roles-list-${lang}`] = await both(`roles-list-${lang}`);

  step(`delete dialog ${lang}`);
  const del = await waitFor(() => q(".roles__delete", first), { what: "a Delete file button" }).catch(() => null);
  if (del) {
    del.click();
    await waitFor(() => q(".roles-delete__files"), { what: "the delete dialog" });
    await sleep(500);
    notes[`roles-delete-${lang}`] = await both(`roles-delete-${lang}`);
    await press("Escape");
    await sleep(400);
  } else notes[`roles-delete-${lang}`] = "skipped: a pure built-in group has no file to delete";
  await press("Escape");
  await sleep(400);

  step(`new run auto ${lang}`);
  await press("n", { meta: true, shift: true });
  const dialog = await waitFor(() => q(".newrun"), { what: "the New run dialog" });
  await waitFor(() => q(".auto-card") && !q(".auto-card__loading"), { what: "the Auto summary", timeout: 20000 });
  await sleep(500);
  notes[`new-run-auto-${lang}`] = await both(`new-run-auto-${lang}`);

  step(`delegating run ${lang}`);
  // The mock provider's lead is the role `mock-auto` (docs 4.3): start it through "Run as role...".
  const asRole = qa("button", dialog).find((b) => /^(Run as role|Futtatás szerepkörként)/.test(text(b)));
  asRole?.click();
  const radio = await waitFor(() => qa('[role="radio"]', dialog).find((r) => /^mock-auto/.test(text(r))), { what: "the mock-auto role", timeout: 10000 }).catch(() => null);
  if (!radio) {
    notes[`run-delegation-${lang}`] = "skipped: mock-auto is not offered (needs INTELY_MOCK_PROVIDER=1)";
    await press("Escape");
    return;
  }
  radio.click();
  const repo = qa('[role="group"] button[aria-pressed]', dialog)[0];
  if (repo && repo.getAttribute("aria-pressed") !== "true") repo.click();
  await typeInto(q("textarea", dialog), lang === "hu" ? "Formázd a végösszegeket a pénznemmel" : "Format the totals with the currency");
  qa("button", dialog).find((b) => hasText(b, /^(Start run|Futás indítása)/))?.click();
  await waitFor(() => !q(".newrun"), { what: "the dialog to close" });
  await waitFor(() => qa(".tool-card__role").length >= 2, { what: "role chips on the sub-agent calls", timeout: 60000 });
  await waitFor(() => qa(".run-header, [data-testid='run-header']").length > 0 && /Done|Kész|Idle|Üresjárat/i.test(text(q("[data-testid='run-header']") ?? document.body)), { what: "the run to finish", timeout: 60000 }).catch(() => {});
  await sleep(600);
  notes[`run-delegation-${lang}`] = await both(`run-delegation-${lang}`);

  step(`inspector roles ${lang}`);
  await press("p", { meta: true, shift: true });
  await waitFor(() => q(".palette"), { what: "the palette" });
  await typeInto(q('.palette [role="combobox"]'), "timeline");
  await sleep(300);
  await press("Enter");
  await waitFor(() => qa(".insp-tool").length > 0, { what: "the Inspector", timeout: 20000 });
  qa('[role="radio"]').find((r) => /^(Session|Munkamenet)/.test(text(r)))?.click();
  await waitFor(() => q(".insp-roles"), { what: "the roles table of the Inspector" });
  await sleep(500);
  notes[`inspector-roles-${lang}`] = await both(`inspector-roles-${lang}`);
}

await phase(0, async () => {
  await rolesShots("en");
  localStorage.setItem("intely.locale", "hu");
  await reloadInto(1);
});
await phase(1, async () => {
  await rolesShots("hu");
  localStorage.setItem("intely.locale", "en");
  await finish();
});
