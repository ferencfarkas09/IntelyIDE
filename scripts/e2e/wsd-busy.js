// (wsd) Switching while busy: a dev server (the scripts/e2e/y-fixture server, copied into shop-backend by the fixture) is running, so the
// guard lists it and "Stop them and switch" stops the process; an unsaved editor buffer asks Save all / Don't save first.
// Needs the fixture to give shop-backend a `dev` script (variant of make-fixture-registry.sh) and the E2E jail (starting a process is
// allowed below the fixture root without the Allow processes switch).
const BEID = FX.repoIds[0];
const serverRows = async () => (await invoke("run_list")).filter((s) => s.id.startsWith(`${BEID}:`) && /running|starting/i.test(String(s.status?.state ?? s.status)));
const pidAlive = async (pid) => !!pid && (await invoke("e2e_pid_alive", { pid }).catch(() => null)) === true;

await phase(0, async () => {
  step("start a dev server");
  await waitShell();
  await openRail("Commit");
  await waitFor(() => treeRepoIds().includes(BEID), { what: "the shop-backend row in the Changes tree", timeout: 30000 });
  const started = await invoke("run_start", { req: { repoId: BEID, script: "npm:dev" } });
  notes.serverId = started.id;
  await waitFor(async () => (await serverRows()).length === 1, { what: "the dev server to run", timeout: 30000 });
  notes.serverPid = (await serverRows())[0]?.pid ?? started.pid ?? null;
  check("the dev server process is alive before the switch (control for the check after it)", await pidAlive(notes.serverPid), String(notes.serverPid));
  step("guard lists it");
  await chooseSwitcherItem("Beta");
  const guard = await waitDialog(/Switch workspace\?/);
  check("the guard names the open workspace", text(guard).includes('Something is still running in "Alpha"'), text(guard).slice(0, 200));
  check("it lists the dev server", /1 dev server is running and will be stopped/.test(text(guard)), text(guard).slice(0, 300));
  check("Cancel is focused first, Stop them and switch is there", document.activeElement?.hasAttribute("data-guard-cancel") && !!findButton("Stop them and switch", guard), String(document.activeElement?.outerHTML).slice(0, 80));
  await window.__e2e.screenshot("guard-dev-server");
  step("cancel");
  await clickButton("Cancel", guard);
  await dialogGone(guard);
  check("cancelling left the server running", (await serverRows()).length === 1);
  check("and the workspace open", switcherLabel() === "Workspace: Alpha", switcherLabel());
  step("stop them and switch");
  await chooseSwitcherItem("Beta");
  const again = await waitDialog(/Switch workspace\?/);
  await actReloadInto(1, () => clickButton("Stop them and switch", again), "Beta to open (page reload)");
});

await phase(1, async () => {
  step("beta after the switch");
  await waitShell();
  const s = await registrySummary();
  check("Beta is open", s.byId[s.activeId]?.name === "Beta", s.byId[s.activeId]?.name);
  check("the dev server is gone", (await serverRows()).length === 0, JSON.stringify(await invoke("run_list")));
  check("and so is its process", !(await pidAlive(notes.serverPid)), String(notes.serverPid));
  check("no process of the old workspace is reported as a survivor", qa(".wsbanner").length === 0, qa(".wsbanner").map((b) => text(b)).join("|"));
  step("unsaved buffer");
  // Open a file in Beta and make it dirty through the editor's own input path, then ask to switch back.
  await openRail("Project");
  const proj = await waitFor(() => q('section[aria-label="Project"]'), { what: "the Project panel" });
  const pos = "shop-pos";
  await waitTreeItem(pos, proj, 20000);
  const root = treeItem(pos, proj);
  if (root.getAttribute("aria-expanded") !== "true") root.click();
  const file = await waitTreeItem("package.json", proj, 20000);
  file.click();
  const view = await waitFor(() => q(".cm-content"), { what: "the editor", timeout: 20000 });
  view.focus();
  document.execCommand("insertText", false, "x");
  await waitFor(() => qa('[role="tab"]').some((t) => /●|dirty/.test(text(t)) || t.querySelector('[data-dirty], .tab-dirty')), { what: "a dirty tab", timeout: 8000 }).catch(() => null);
  await chooseSwitcherItem("Alpha");
  const guard = await waitDialog(/Switch workspace\?/);
  check("unsaved files are listed with a Save all button", /1 unsaved file/.test(text(guard)) && !!findButton("Save all and switch", guard) && !!findButton("Don't save and switch", guard), text(guard).slice(0, 300));
  await window.__e2e.screenshot("guard-unsaved");
  await actReloadInto(2, () => clickButton("Don't save and switch", guard), "Alpha to open (page reload)");
});

await phase(2, async () => {
  step("alpha again");
  await waitShell();
  const s = await registrySummary();
  check("Alpha is open again", s.byId[s.activeId]?.name === "Alpha");
  await finish();
});
