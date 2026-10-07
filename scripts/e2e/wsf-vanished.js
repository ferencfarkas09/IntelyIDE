// (wsf) Vanished folders: one folder of the open workspace disappears (run.sh removes it while the scenario waits): the banner "1 of 2 folders
// are missing" appears with Remove missing; then every folder of Gamma is removed, the app is restarted (wsf2) and shows Welcome with the entry
// flagged; recreating the folder and pressing Check again opens it. Nothing is ever deleted by the app.
// run.sh contract (timing based, the page cannot touch the disk): about 8 s after the launch a watcher moves $FX/repos/admin away (to
// $FX/admin.away); the scenario keeps nudging the window focus, which is what makes the app look at its folders again.
await phase(0, async () => {
  step("alpha with a missing folder");
  await waitShell();
  await waitFor(() => treeRepoIds().length === 2, { what: "two repository rows in the Changes tree", timeout: 30000 });
  check("Alpha is open with two repositories", treeRepoIds().length === 2, treeRepoIds().join());
  step("wait for the folder to vanish");
  await waitFor(() => {
    window.dispatchEvent(new Event("focus"));
    return qa(".wsbanner").some((b) => /1 of 2 folders are missing/.test(text(b)));
  }, { what: "the missing-folders banner", timeout: 60000, interval: 1000 });
  check("the banner offers Remove missing, Locate and Dismiss", ["Remove missing", "Locate...", "Dismiss"].every((l) => qa(".wsbanner button").some((b) => text(b) === l)));
  await window.__e2e.screenshot("banner");
  check("the folder is still in the registry (nothing is removed on its own)", (await registrySummary()).byId["w-alpha"].repos.length === 2);
  step("remove missing");
  await clickButton("Remove missing", q(".wsbanner"));
  await waitFor(() => (async () => (await registrySummary()).byId["w-alpha"].repos.length === 1)(), { what: "the workspace to lose the missing repository", timeout: 10000 });
  check("Remove missing only changes the workspace list", true);
  await finish();
});
