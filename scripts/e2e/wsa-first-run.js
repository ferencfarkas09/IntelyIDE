// (wsa) First run: an empty registry shows Welcome; Open folder (a native pick answered from pick.jsonl) makes a one-repository workspace that
// opens after the reload; New workspace from two picks; Close workspace; a folder dropped on Welcome goes through the review card.
// pick.jsonl: line 1 = [shop-backend], line 2 = [admin, shop-mobile].
await phase(0, async () => {
  step("welcome");
  await waitWelcome();
  check("Welcome heading", text(q("h1")) === "Welcome to IntelyIDE", text(q("h1")));
  check("Welcome offers Open folder, New workspace, Scan", qa(".welcome__action").map((b) => text(q(".welcome__action-title", b))).join("|") === "Open folder...|New workspace...|Scan a folder for repositories...");
  check("the recent list is the empty state", text(welcomeEl()).includes("No workspaces yet. Open a folder to start."));
  check("no workspace in the registry", (await registrySummary()).names.length === 0);
  check("the safe-by-design card is shown", text(welcomeEl()).includes("Safe by design"));
  await window.__e2e.screenshot("welcome-empty");
  step("open folder");
  await actReloadInto(1, async () => {
    qa(".welcome__action")[0].click();
    await confirmPickerIfShown();
  }, "the workspace to open (page reload)");
});

await phase(1, async () => {
  step("one-repository workspace");
  await waitShell();
  const s = await registrySummary();
  check("one workspace, named after the folder", s.names.length === 1 && s.names[0] === "shop-backend", s.names.join(","));
  const only = Object.values(s.byId)[0];
  check("it was opened from a folder and is the active one", only.origin === "openedFolder" && s.activeId === only.id, `${only.origin} ${s.activeId}`);
  check("the switcher names it", switcherLabel() === "Workspace: shop-backend", switcherLabel());
  await waitFor(() => treeRepoIds().length === 1, { what: "one repo row in the Changes tree" });
  check("the Changes tree shows that repository", treeRepoIds()[0]?.startsWith("shop-backend-"), treeRepoIds().join());
  check("the 'switched' hand-off toast was shown", toastText().includes("Switched to shop-backend"), toastText());
  await window.__e2e.screenshot("one-repo");
  step("new workspace");
  await chooseSwitcherItem("New workspace");
  let d = await waitDialog(/New workspace/);
  await clickButton("Add folders...", d);
  await confirmPickerIfShown();
  d = await waitDialog(/New workspace/);   // the dialog under the picker is the same one, but look it up again
  await waitFor(() => qa(".wsdlg__row", d).length === 2, { what: "two repository rows" });
  check("both picked folders are rows", qa('.wsdlg__row input[aria-label="Display name"]', d).map((i) => i.value).join("|") === "admin|shop-mobile");
  await typeInto(q('input[placeholder="My projects"]', d), "Two repos");
  await window.__e2e.screenshot("new-workspace");
  await actReloadInto(2, () => clickButton("Create and open", d), "the new workspace to open (page reload)");
});

await phase(2, async () => {
  step("opened");
  await waitShell();
  const s = await registrySummary();
  check("two workspaces now", s.names.length === 2 && s.names.includes("Two repos"), s.names.join(","));
  const active = s.byId[s.activeId];
  check("the new one is open with its two repositories", active?.name === "Two repos" && active.repos.length === 2, JSON.stringify(active?.repos.map((r) => r.name)));
  step("close workspace");
  await actReloadInto(3, () => chooseSwitcherItem("Close workspace"), "the workspace to close (page reload)");
});

await phase(3, async () => {
  step("welcome with recents");
  await waitWelcome();
  await waitFor(() => recentItems().length === 2, { what: "two recent workspaces" });
  check("the recent list shows both, newest first", recentItems().map((li) => text(q(".recent__name", li))).join("|") === "Two repos|shop-backend", recentItems().map((li) => text(q(".recent__name", li))).join("|"));
  check("closing says so", toastText().includes("Workspace closed"), toastText());
  await window.__e2e.screenshot("welcome-recents");
  step("drop a folder");
  await dropFolders([wsRepoPath("pos")]);
  const review = await waitDialog(/Open this folder as a workspace/);
  check("the dropped folder goes through the review card", text(review).includes("shop-pos"), text(review).slice(0, 200));
  await actReloadInto(4, () => clickButton("Create and open", review), "the dropped folder to open (page reload)");
});

await phase(4, async () => {
  step("dropped folder opened");
  await waitShell();
  const s = await registrySummary();
  check("three workspaces, the dropped one open", s.names.length === 3 && s.byId[s.activeId]?.name === "shop-pos", s.names.join(","));
  await finish();
});
