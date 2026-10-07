// (wsb2) Second launch against the registry wsb left: nothing is migrated again (no notice), run.sh compares the registry bytes before and after.
await phase(0, async () => {
  step("second start");
  await waitShell();
  const s = await registrySummary();
  check("still one workspace, Happy workspace, open", s.names.join(",") === "Happy workspace" && s.activeId === "w-migrated", `${s.names.join(",")} ${s.activeId}`);
  check("no migration notice this time", !toastText().includes("moved to the new workspace list"), toastText());
  check("the switcher still shows it", switcherLabel() === "Workspace: Happy workspace", switcherLabel());
  await waitForTree();
  await finish();
});
