// (wsc2) Relaunch with the registry and the web store wsc left (INTELY_E2E_STORE): the last open workspace opens by itself and its tabs are restored.
await phase(0, async () => {
  step("relaunch");
  await waitShell();
  const s = await registrySummary();
  check("the workspace that was open last opens again", s.byId[s.activeId]?.name === "Alpha", s.byId[s.activeId]?.name);
  await waitFor(() => qa('[role="tab"]').some((t) => /package\.json/.test(text(t))), { what: "the saved tab restored", timeout: 20000 });
  check("the saved file tab is back after a relaunch", true);
  check("no switch toast on a plain launch", !toastText().includes("Switched to"), toastText());
  await window.__e2e.screenshot("relaunched");
  await finish();
});
