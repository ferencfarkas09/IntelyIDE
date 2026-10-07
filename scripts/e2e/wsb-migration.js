// (wsb) Migration: a legacy workspace.json (four repos, a push target, a live branch) and no registry become the registry with one workspace
// "Happy workspace" (id w-migrated) on the first start. run.sh checks the files: sha256 of workspaces/w-migrated.json equals the legacy file,
// the backup exists and workspace.json is untouched.
await phase(0, async () => {
  step("migrated start");
  await waitShell();
  const s = await registrySummary();
  check("one workspace named Happy workspace", s.names.length === 1 && s.names[0] === "Happy workspace", s.names.join(","));
  check("its id is the fixed migrated id and it is open", s.activeId === "w-migrated" && s.byId["w-migrated"]?.origin === "migrated", `${s.activeId} ${s.byId["w-migrated"]?.origin}`);
  check("it holds the four repositories", s.byId["w-migrated"]?.repos.length === 4, String(s.byId["w-migrated"]?.repos.length));
  check("the switcher shows the migrated name", switcherLabel() === "Workspace: Happy workspace", switcherLabel());
  const ws = await invoke("workspace_get");
  check("the legacy ids are kept verbatim", ws.repos.map((r) => r.id).join(",") === FX.repoIds.join(","), ws.repos.map((r) => r.id).join(","));
  check("the push target and the live branch survived", Object.keys(ws.repos.flatMap((r) => Object.keys(r.pushTargets))).length > 0 && Object.keys(ws.liveBranches ?? {}).length > 0, JSON.stringify({ pt: ws.repos.map((r) => Object.keys(r.pushTargets)), live: ws.liveBranches }));
  check("the migration notice was shown once", toastText().includes("Your workspace was moved to the new workspace list."), toastText());
  await waitForTree();
  check("the tree shows every repository with its changes", treeRepoIds().length === 4);
  await window.__e2e.screenshot("migrated");
  await finish();
});
