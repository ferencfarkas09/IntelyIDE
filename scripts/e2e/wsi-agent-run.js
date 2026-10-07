// (wsi) Switching while an agent run is active (the mock provider through the real sidecar): the switcher answers with the guard instead of
// switching; Cancel leaves the run going in the same workspace; "Stop them and switch" interrupts the run, opens Beta, and the run does not
// follow (no agent of Alpha is active in Beta). Needs INTELY_MOCK_PROVIDER=1 (run.sh sets it for wsi).
await phase(0, async () => {
  step("start a long run in Alpha");
  await waitShell();
  await openRail("Commit");
  await waitFor(() => treeRepoIds().includes("shop-backend"), { what: "the shop-backend row", timeout: 30000 });
  await openAgents();
  await newRun("mock-interrupt", ["shop-backend"], "run for a long time");
  await waitFor(() => /sleep 30|Bash/.test(panelText()), { what: "the running tool", timeout: 30000 });
  check("the run is active", runStatusText() !== "Done" && runStatusText() !== "Failed", runStatusText());

  step("the switch is refused");
  await chooseSwitcherItem("Beta");
  const guard = await waitDialog(/Switch workspace\?/);
  check("the guard names Alpha and the active agent run", text(guard).includes('Something is still running in "Alpha"') && /1 agent run is active/.test(text(guard)), text(guard).slice(0, 300));
  check("Cancel is where the focus starts", document.activeElement?.hasAttribute("data-guard-cancel"), String(document.activeElement?.outerHTML).slice(0, 80));
  await window.__e2e.screenshot("guard-agent-run");
  await clickButton("Cancel", guard);
  await dialogGone(guard);
  const s = await registrySummary();
  check("Alpha is still the open workspace", s.byId[s.activeId]?.name === "Alpha" && switcherLabel() === "Workspace: Alpha", switcherLabel());
  check("and the run is still going", runStatusText() !== "Done" && runStatusText() !== "Failed", runStatusText());

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
  const busy = await invoke("workspaces_busy");
  check("nothing is busy any more", busy.blocking.length === 0 && busy.confirmable.length === 0, JSON.stringify(busy));
  check("the switch toast names Beta", toastText().includes("Switched to Beta"), toastText());
  await finish();
});
