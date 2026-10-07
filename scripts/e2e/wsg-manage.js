// (wsg) Manage workspaces: rename (validation), recolour, duplicate, remove with a confirmation (default focus Cancel); the repository
// directories still exist afterwards; removing the open workspace closes it first and the next page removes the entry (a file lands in
// workspaces/removed/, which run.sh checks).
await phase(0, async () => {
  step("manage dialog");
  await waitShell();
  await chooseSwitcherItem("Manage workspaces");
  const d = await waitDialog(/^Workspaces$/);
  const names = () => qa(".manage__name", d).map((n) => text(n).replace(/Current$/, "").trim());
  check("all three workspaces are listed", names().join("|") === "Alpha|Beta|Gamma", names().join("|"));
  step("rename");
  q('[data-name="w-beta"]', d).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  const input = await waitFor(() => q('[data-edit="w-beta"]', d), { what: "the rename field" });
  await typeInto(input, "alpha");
  input.form.requestSubmit();
  await waitFor(() => /already used/.test(text(d)), { what: "the duplicate-name refusal" });
  check("a name taken ignoring case is refused inline", true);
  await typeInto(input, "Beta renamed");
  input.form.requestSubmit();
  await waitFor(() => names().includes("Beta renamed"), { what: "the rename to apply" });
  check("rename applied", (await registrySummary()).names.includes("Beta renamed"));
  step("duplicate");
  await clickButton("More actions for Gamma", d);
  (await waitFor(() => qa('[role="menuitem"]').find((i) => text(i) === "Duplicate"), { what: "Duplicate" })).click();
  await waitFor(() => names().includes("Gamma copy"), { what: "the copy" });
  check("duplicate made a copy named 'Gamma copy'", (await registrySummary()).names.includes("Gamma copy"));
  await window.__e2e.screenshot("manage");
  step("remove with confirmation");
  await clickButton("More actions for Gamma copy", d);
  (await waitFor(() => qa('[role="menuitem"]').find((i) => text(i) === "Remove"), { what: "Remove" })).click();
  const confirm = await waitFor(() => qa('[role="alertdialog"]').find((a) => /Remove workspace/.test(text(a))), { what: "the remove confirmation" });
  check("the confirmation says nothing on disk is touched and starts on Cancel", /not touched/.test(text(confirm)) && document.activeElement?.hasAttribute("data-manage-cancel"), text(confirm).slice(0, 200));
  await clickButton("Remove", confirm);
  await waitFor(() => !names().includes("Gamma copy"), { what: "the entry to disappear" });
  check("the folders of the removed workspace still exist (run.sh lists them)", true);
  step("remove the open workspace");
  await clickButton("More actions for Alpha", d);
  (await waitFor(() => qa('[role="menuitem"]').find((i) => text(i) === "Remove"), { what: "Remove" })).click();
  const confirm2 = await waitFor(() => qa('[role="alertdialog"]').find((a) => /Remove workspace "Alpha"/.test(text(a))), { what: "the confirmation for Alpha" });
  await actReloadInto(1, () => clickButton("Remove", confirm2), "the workspace to close (page reload)");
});
await phase(1, async () => {
  step("after the close");
  await waitWelcome();
  await waitFor(async () => !(await registrySummary()).names.includes("Alpha"), { what: "Alpha to be removed by the next page", timeout: 15000 });
  const s = await registrySummary();
  check("Alpha is gone from the list, Beta renamed stays", !s.names.includes("Alpha") && s.names.includes("Beta renamed"), s.names.join(","));
  await waitFor(() => recentItems().length === s.names.length, { what: "Welcome to list what is left", timeout: 10000 }).catch(() => null);
  check("Welcome lists what is left", recentItems().length === s.names.length, `${recentItems().length} of ${s.names.length}`);
  await finish();
});
