// (wsf2) Relaunch after every folder of the open workspace is gone (run.sh removed them): Welcome opens with the entry flagged "Folder not
// found"; Open shows the reason on the row; once run.sh has moved the folder back ($FX/admin.away -> $FX/repos/admin, about 20 s after the
// launch; the folder was moved away before the launch), Check again opens the workspace. Gamma (id w-gamma: admin alone) is the active one.
await phase(0, async () => {
  step("welcome flagged");
  await waitWelcome();
  const view = await workspacesView();
  check("the registry kept the workspace as the active one (never decided by a stat in the registry)", view.activeId === view.openError?.id && view.openError?.reason === "allMissing", JSON.stringify(view.openError));
  const row = await waitFor(() => recentNamed("Gamma"), { what: "the Gamma row" });
  await waitFor(() => /Folder not found/.test(text(row)), { what: "the status on the row", timeout: 20000 });
  check("the row says Folder not found and offers Locate, Remove, Check again", ["Locate...", "Remove from list", "Check again"].every((l) => qa("button", row).some((b) => text(b) === l)), text(row));
  await window.__e2e.screenshot("flagged");
  q(".recent__main", row).click();
  await sleep(300);
  check("opening it says why on the row instead of a vanishing toast", /Folder not found/.test(text(q(".recent__error", row) ?? "")), text(row));
  step("wait for the folder to come back");
  currentPhase = 1;
  expectReload();
  const t0 = performance.now();
  while (performance.now() - t0 < 80000) {
    findButton("Check again", recentNamed("Gamma") ?? document)?.click();
    await sleep(3000);
  }
  throw new Error("timeout (80 s) waiting for the workspace to open once its folder is back");
});
await phase(1, async () => {
  step("opened");
  await waitShell();
  const s = await registrySummary();
  check("Gamma is open again", s.byId[s.activeId]?.name === "Gamma", s.byId[s.activeId]?.name);
  await finish();
});
