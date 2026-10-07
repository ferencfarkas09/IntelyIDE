// (h) Partial selection (tri-state), Amend (prefill, multi-repo refusal, pushed-commit warning, amending an unpushed
// commit), force push with lease on a protected branch (typed branch name), Edit all targets, the sensitive-file guard.
await waitForTree();
const B = "shop-backend";
const A = "admin";
const SV = "shop-mobile";
const P = "shop-pos";

// ---- partial selection: tri-state --------------------------------------------------------------------------------
check("backend starts fully ticked", tick(await findRow(repoRowSel(B))) === "true", tick(await findRow(repoRowSel(B))));
const fullLabel = text(commitButton());
const files = qa(`[data-row="file"][data-repo="${B}"]`).map((r) => r.getAttribute("data-path"));
check("backend lists its changed files", files.length >= 5, String(files.length));
await setTick(fileRowSel(B, files[0]), "false", files[0]);
check("unticking one file makes the repo row mixed", tick(await findRow(repoRowSel(B))) === "mixed", tick(await findRow(repoRowSel(B))));
const filesIn = (label) => Number(/(\d+) files?\)/.exec(label)?.[1]);
const mixedLabel = text(commitButton());
check("…and the commit button counts one file less", filesIn(mixedLabel) === filesIn(fullLabel) - 1, `${fullLabel} -> ${mixedLabel}`);
await setTick(fileRowSel(B, files[0]), "true", files[0]);
check("re-ticking it makes the repo row fully ticked again", tick(await findRow(repoRowSel(B))) === "true");
check("the commit button count returns", text(commitButton()) === fullLabel, text(commitButton()));
// a folder of untracked files: ticking one makes the folder and the Unversioned node mixed
await expandRow(unversionedSel(A));
const loyalty = await waitFor(() => findRow(dirRowSel(A, "src/components/pages/loyalty/")), { what: "loyalty folder" }).catch(() => null);
if (loyalty) {
  await expandRow(dirRowSel(A, "src/components/pages/loyalty/"));
  const part = await waitFor(() => findRow(fileRowSel(A, "src/components/pages/loyalty/Part01.tsx")), { what: "Part01.tsx" });
  await setTick(fileRowSel(A, part.getAttribute("data-path")), "true", "Part01.tsx");
  check("one ticked file in a folder makes the folder mixed", tick(await findRow(dirRowSel(A, "src/components/pages/loyalty/"))) === "mixed", tick(await findRow(dirRowSel(A, "src/components/pages/loyalty/"))));
  check("…and the Unversioned node mixed too", tick(await findRow(unversionedSel(A))) === "mixed", tick(await findRow(unversionedSel(A))));
  await setTick(fileRowSel(A, part.getAttribute("data-path")), "false", "Part01.tsx");
  check("unticking it clears the folder", tick(await findRow(dirRowSel(A, "src/components/pages/loyalty/"))) === "false");
} else {
  skip("untracked folder tri-state", "no loyalty folder in admin");
}

// ---- Amend: multi-repo refusal ------------------------------------------------------------------------------------
const amendBox = () => qa('input[type="checkbox"]', q(".commit-panel__tools")).find(Boolean);
await setTick(repoRowSel(A), "true", "repo admin");
check("with files ticked in two repos Amend is disabled", amendBox().disabled === true, String(amendBox().disabled));
// ---- Amend: pushed-commit warning (shop-pos is in sync with its remote) ------------------------------------------
for (const id of [B, A, SV]) await untickRepo(id);
await setTick(repoRowSel(P), "true", "repo shop-pos");
check("with one repo ticked Amend is enabled", amendBox().disabled === false);
amendBox().click();
const lastMessage = await invoke("commit_message_last", { repoId: P });
await waitFor(() => textarea()?.value === lastMessage, { what: "Amend to prefill the last commit message", timeout: 8000 });
check("Amend prefills the message of the last commit", textarea().value === lastMessage && lastMessage.length > 0, `${textarea().value} | ${lastMessage}`);
await waitFor(() => /already pushed/.test(text(q(".commit-panel"))), { what: "pushed-commit warning", timeout: 5000 });
check("Amending an already pushed commit warns that a force push is needed", /already pushed; amending it needs a force push/.test(text(q(".commit-panel"))));
amendBox().click();
await waitFor(() => textarea()?.value === "", { what: "message to clear again", timeout: 5000 });
check("turning Amend off removes the prefilled message", textarea().value === "");
check("…and the warning", !/already pushed/.test(text(q(".commit-panel"))));

// ---- Amend of an unpushed commit (shop-backend is one commit ahead) -------------------------------------------
notes.backendHeadBefore = await invoke("commit_message_last", { repoId: B });
await untickRepo(P);
await setTick(repoRowSel(B), "true", "repo backend");
amendBox().click();
await waitFor(() => textarea()?.value === notes.backendHeadBefore, { what: "backend's last message", timeout: 8000 });
check("no pushed-commit warning for an unpushed commit", !/already pushed/.test(text(q(".commit-panel"))));
await typeInto(textarea(), "e2e: amended message");
commitButton().click();
await waitFor(sheetSettled, { what: "amend result", timeout: 60000 });
check("the amend finished", sheetRows()["shop-backend"] === "Done", JSON.stringify(sheetRows()));
await closeResults();

// ---- force push with lease on a protected branch (shop-mobile is on main) ----------------------------------
check("Amend is off again after the commit", amendBox().checked === false, String(amendBox().checked));
await untickRepo(B);
await setTick(repoRowSel(SV), "true", "repo services");
await useMode("Shared");
await sharedMessage("e2e: services on main");
await chooseMenuItem("More commit actions", "Commit and Push", q(".commit-panel__actions"));
const dialog = await waitFor(pushDialog, { what: "push dialog", timeout: 60000 });
await waitFor(() => qa("[data-key^='repo:']", dialog).length === 4, { what: "4 repos" });
const svBox = q(`input[aria-label="Push ${"shop-mobile"}"]`, dialog);
check("services (main) is ticked with its new commit", svBox?.checked === true && !svBox.disabled);
check("the protected branch is marked", !!q('[aria-label="Protected branch"], .push-target__lock', q("[data-key='repo:shop-mobile']", dialog)));
// only services is pushed
for (const name of ["shop-backend", "admin"]) {
  const box = q(`input[aria-label="Push ${name}"]`, dialog);
  if (box?.checked) { box.click(); await sleep(80); }
}
check("backend and admin are unticked for this push", !q('input[aria-label="Push shop-backend"]', dialog).checked && !q('input[aria-label="Push admin"]', dialog).checked);
// the live-branch confirmation (the push dialog's own) comes first: until it matches, even the force menu is disabled
await typeInto(await waitFor(() => q('input[aria-label^="Type main to push shop-mobile"]', dialog), { what: "live-branch confirmation field" }), "main");
await chooseMenuItem("More push actions", "Force push", dialog);
const force = await waitFor(() => qa('[role="alertdialog"]').find((d) => /Force push with lease/.test(text(d))), { what: "force-push dialog" });
const forceBtn = () => findButton("Force push", force);
check("Force push is disabled until the branch name is typed", forceBtn()?.disabled === true);
const confirmInput = await waitFor(() => q('input[aria-label^="Type main to confirm"]', force), { what: "typed confirmation field" });
check("the dialog asks to type the branch name main", /Type\s*main\s*to confirm/.test(text(force)), text(force).slice(0, 200));
await typeInto(confirmInput, "mai");
check("a partial name does not unlock it", forceBtn().disabled === true);
await typeInto(confirmInput, "master");
check("a wrong name does not unlock it", forceBtn().disabled === true);
await typeInto(confirmInput, "main");
check("the exact name unlocks Force push", forceBtn().disabled === false);
forceBtn().click();
await waitFor(() => !pushDialog(), { what: "push dialog to close", timeout: 60000 });
await waitFor(() => sheet() && sheetSettled(), { what: "force push result", timeout: 60000 });
check("the force push with lease succeeded", /Pushed|Done/.test(sheetRows()["shop-mobile"] ?? ""), JSON.stringify(sheetRows()));
await closeResults();

// ---- Edit all targets: save a push target for shop-backend ----------------------------------------------------
await press("k", { meta: true, shift: true });
const dialog2 = await waitFor(pushDialog, { what: "push dialog", timeout: 15000 });
await waitFor(() => qa("[data-key^='repo:']", dialog2).length === 4, { what: "4 repos" });
await clickButton("Edit all targets", dialog2);
const editAll = await waitFor(() => qa('[role="dialog"]').find((d) => /Edit all push targets/.test(text(d))), { what: "Edit all targets dialog" });
const branchInput = await waitFor(() => q('input[aria-label="Remote branch for shop-backend"]', editAll), { what: "remote branch field" });
check("the field starts with the current remote branch", branchInput.value === "sandbox", branchInput.value);
await typeInto(branchInput, "sandbox-e2e");
await clickButton("Save targets", editAll);
await waitFor(() => !editAll.isConnected || !qa('[role="dialog"]').includes(editAll), { what: "Edit all targets to close", timeout: 8000 });
const row = () => q("[data-key='repo:shop-backend']", pushDialog());
await waitFor(() => /origin\/sandbox-e2e/.test(text(row())), { what: "the saved target in the dialog", timeout: 8000 });
check("the saved target shows in the push dialog", /origin\/sandbox-e2e/.test(text(row())), text(row()));
const ws = await invoke("workspace_get");
const saved = ws.repos.find((r) => r.id === B)?.pushTargets;
check("the target is stored in the workspace", saved?.sandbox?.branch === "sandbox-e2e" && saved?.sandbox?.remote === "origin", JSON.stringify(saved));
// push backend to its new target (admin stays out)
for (const name of ["admin", "shop-mobile", "shop-pos"]) {
  const box = q(`input[aria-label="Push ${name}"]`, pushDialog());
  if (box?.checked) { box.click(); await sleep(80); }
}
await clickButton("Push", pushDialog());
await waitFor(() => !pushDialog(), { what: "dialog to close", timeout: 60000 });
await waitFor(() => sheet() && sheetSettled(), { what: "push result", timeout: 60000 });
check("backend pushed to the new target", /Pushed|Done/.test(sheetRows()["shop-backend"] ?? ""), JSON.stringify(sheetRows()));
await closeResults();

// ---- sensitive-file guard (skipped while the engine does not report GuardState `sensitive`) ----------
const snap = await invoke("snapshot_get", { repoId: P });
const npmrc = snap.changes?.find((c) => c.path === ".npmrc");
if (!npmrc) {
  skip("sensitive guard", "the fixture has no modified .npmrc in shop-pos");
} else if (npmrc.guard !== "sensitive") {
  skip("sensitive guard", `GuardState "sensitive" is not available yet (the engine reports guard=${JSON.stringify(npmrc.guard)} for the tracked .npmrc)`);
} else {
  // The engine flags a tracked secret-looking file `sensitive`: selectable (not locked), unlike a new one. The row carries a
  // warn-coloured lock badge (.chg-lock[data-sensitive]) and committing it asks for one more confirmation.
  const rowNpmrc = await findRow(fileRowSel(P, ".npmrc"));
  check("the tracked .npmrc is selectable, not locked", rowNpmrc?.getAttribute("aria-disabled") !== "true" && !q(".chg-lock:not([data-sensitive])", rowNpmrc), rowNpmrc?.outerHTML.slice(0, 200));
  const marked = !!q(".chg-lock[data-sensitive]", rowNpmrc);
  notes.sensitiveRow = { ticked: tick(rowNpmrc), marked };
  if (!marked) {
    skip("sensitive confirmation", "the .npmrc row has no sensitive lock badge");
  } else {
    await untickRepo(B); await untickRepo(SV); await untickRepo(A);
    await setTick(repoRowSel(P), "true", "repo shop-pos");
    await setTick(fileRowSel(P, ".npmrc"), "true", ".npmrc");
    await sharedMessage("e2e: sensitive");
    await press("Enter", { meta: true });
    const confirm = await waitFor(() => qa('[role="dialog"], [role="alertdialog"]').find((d) => /npmrc/.test(text(d))), { what: "sensitive-file confirmation", timeout: 8000 });
    check("committing a sensitive file asks for confirmation naming it", !!confirm, text(confirm).slice(0, 200));
    await clickButton("Cancel", confirm);
    check("cancelling starts no commit", !sheet());
  }
}
await finish();
