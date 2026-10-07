// (x0) MongoDB Studio in a LEAN build (no cargo feature `mongo-studio`): the zero-cost proof on the real window. The build has no
// `mongo_*` command at all, Settings > Database says so and its switch cannot be turned on, and there is no Database rail item.
// Run this scenario with a lean binary (scripts/e2e/run.sh --bin <lean binary> --only x0); with a studio build it fails on purpose.
await waitForTree();
const dlg = () => q(".settings");
async function openSettings(section) {
  if (!dlg()) { await press(",", { meta: true }); await waitFor(dlg, { what: "Settings" }); }
  (await waitFor(() => qa(".settings__item", dlg()).find((b) => text(b) === section), { what: `the ${section} section` })).click();
  await sleep(250);
}
step("lean");
let err = null;
try { await invoke("mongo_status"); } catch (e) { err = e; }
check("a lean build has no mongo_status command (the IPC call is rejected)", err !== null, String(err?.message ?? err).slice(0, 120));
for (const cmd of ["mongo_connect", "mongo_run", "mongo_ai_generate", "mongo_profile_save"]) {
  let e2 = null;
  try { await invoke(cmd, {}); } catch (e) { e2 = e; }
  check(`... nor ${cmd}`, e2 !== null, String(e2?.message ?? e2).slice(0, 100));
}
check("no Database rail item", !railButton("Database"));
await openSettings("Database");
const sw = await waitFor(() => q('[role="switch"][aria-label="Enable MongoDB Studio"]', q(".settings__pane", dlg())), { what: "the studio switch" });
check("Settings > Database: the switch is disabled and says the build has no studio", (sw.disabled || sw.getAttribute("aria-disabled") === "true") && /does not include the (studio|database module)/.test(text(q(".settings__pane", dlg()))), text(q(".settings__pane", dlg())).slice(0, 300));
await snap("mongo-lean-settings");
await press("Escape");
await finish();
