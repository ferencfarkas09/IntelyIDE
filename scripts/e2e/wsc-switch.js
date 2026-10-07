// (wsc) Two workspaces: tabs in Alpha, switch to Beta (reload), no snapshot of Alpha is visible, Beta's tabs are its own, switching back restores
// Alpha's tabs. wsc2 relaunches the same registry and store: the saved tabs come back (manual check M9 automated).
const waitForRepos = async (ids) => {
  await openRail("Commit");   // the rail choice outlives a switch (the web store is persistent), and the tree is in the Commit panel
  for (const id of ids) await waitFor(() => treeRepoIds().includes(id), { what: `repo row ${id}`, timeout: 30000 });
};
const fileTabs = () => qa('[role="tab"]').map((t) => text(t));

await phase(0, async () => {
  step("alpha");
  await waitShell();
  const s = await registrySummary();
  check("Alpha is open", s.byId[s.activeId]?.name === "Alpha", s.byId[s.activeId]?.name);
  await waitForRepos(["shop-backend", "admin"]);
  check("only Alpha's repositories are in the tree", treeRepoIds().sort().join() === "admin,shop-backend", treeRepoIds().join());
  await openRail("Project");
  const proj = await waitFor(() => q('section[aria-label="Project"]'), { what: "the Project panel" });
  await waitTreeItem(BACKEND, proj, 20000);
  const root = treeItem(BACKEND, proj);
  if (root.getAttribute("aria-expanded") !== "true") root.click();
  const file = await waitTreeItem("package.json", proj, 20000);
  file.click();
  await waitFor(() => fileTabs().some((t) => /package\.json/.test(t)), { what: "package.json open in a tab" });
  check("a file tab is open in Alpha", fileTabs().some((t) => /package\.json/.test(t)), fileTabs().join("|"));
  await snap("alpha-tabs");
  step("switch to Beta");
  await actReloadInto(1, () => chooseSwitcherItem("Beta"), "Beta to open (page reload)");
});

await phase(1, async () => {
  step("beta");
  await waitShell();
  const s = await registrySummary();
  check("Beta is open", s.byId[s.activeId]?.name === "Beta", s.byId[s.activeId]?.name);
  await waitForRepos(["shop-mobile", "shop-pos"]);
  check("no repository of Alpha is visible", !treeRepoIds().includes("shop-backend") && !treeRepoIds().includes("admin"), treeRepoIds().join());
  check("no package.json tab of Alpha", !fileTabs().some((t) => /package\.json/.test(t)), fileTabs().join("|"));
  check("the switch toast names Beta", toastText().includes("Switched to Beta"), toastText());
  await snap("beta");
  step("back to Alpha");
  await actReloadInto(2, () => chooseSwitcherItem("Alpha"), "Alpha to open again (page reload)");
});

await phase(2, async () => {
  step("alpha again");
  await waitShell();
  await waitForRepos(["shop-backend", "admin"]);
  await waitFor(() => fileTabs().some((t) => /package\.json/.test(t)), { what: "Alpha's file tab restored", timeout: 15000 });
  check("Alpha's tab came back", fileTabs().some((t) => /package\.json/.test(t)), fileTabs().join("|"));
  const s = await registrySummary();
  check("Alpha is the open workspace again", s.byId[s.activeId]?.name === "Alpha");
  await finish();
});
