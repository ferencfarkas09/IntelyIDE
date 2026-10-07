// (wse) Scan: $FX/scan holds three repositories, a node_modules decoy, a symlink to a repository and a nested repository. The scan finds the
// three, skips the decoy and the symlink and does not descend into the nested one; two are ticked and become "A new workspace".
// pick.jsonl: line 1 = [$FX/scan] (the folder to scan).
await phase(0, async () => {
  step("scan");
  await waitShell();
  await chooseSwitcherItem("Scan a folder");
  await confirmPickerIfShown();
  const d = await waitDialog(/Scan for repositories/);
  await waitFor(() => /Scan finished|Scan stopped/.test(text(d)), { what: "the scan to finish", timeout: 30000 });
  const names = qa(".wsdlg__row strong", d).map((n) => text(n));
  check("three repositories were found", names.length === 3, names.join("|"));
  check("the decoy inside node_modules is not listed", !names.some((n) => /decoy|node_modules/.test(n)), names.join("|"));
  check("the symlink is reported, not followed", /symbolic link was not followed/.test(text(d)), text(d).slice(0, 400));
  check("every repository is ticked by default", qa('.wsdlg__row input[type="checkbox"]:checked', d).length === 3);
  await window.__e2e.screenshot("scan-results");
  step("tick two");
  await clickButton("Select none", d);
  const boxes = qa('.wsdlg__row input[type="checkbox"]', d);
  boxes[0].click();
  boxes[1].click();
  await waitFor(() => findButton("Add 2 repositories", d), { what: "the Add 2 repositories button" });
  await typeInto(q("input", qa("label", d).find((l) => /Workspace name/.test(text(l)))), "Scanned");
  await actReloadInto(1, () => clickButton("Add 2 repositories", d), "the scanned workspace to open (page reload)");
});

await phase(1, async () => {
  step("scanned workspace");
  await waitShell();
  const s = await registrySummary();
  const active = s.byId[s.activeId];
  check("a workspace named Scanned with two repositories is open", active?.name === "Scanned" && active.repos.length === 2 && active.origin === "scanned", JSON.stringify(active && [active.name, active.origin, active.repos.length]));
  await finish();
});
