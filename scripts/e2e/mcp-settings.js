// Scenario "mcs" (opt-in: --only mcs; (design notes: mcp-management-spec) 7 and 9.5, the Settings half): Settings > MCP servers on a fresh data directory with
// the memory secret store (INTELY_E2E forces it). Everything is driven through the real UI; no agent run and no model call:
//   1. the empty state with Add and Import as the only actions                                       (empty)
//   2. add a stdio server with a secret variable (a canary typed into the field), "Save and test"     (editor)
//   3. the confirm dialog gates the Test: Cancel has the focus, the secret value is not in it         (confirm)
//   4. Confirm and test: the result under the row, the three fixture tools with what the server says, a blocked-by-default tool (test-ok)
//   5. rules: one Select per tool, the default rule, "On by default" stays on
//   6. the canary is nowhere in the page (DOM, any input value) and not in `mcp_list`
//   7. Edit shows the stored secret masked, with no way to read it; the Import dialog opens (choose step)   (import)
//   8. changing the command makes the record "needs confirmation" again; the switch is gated by the dialog, Cancel leaves it off
//   9. remove the server; the empty state is back
// Shots (dark and light, the app's own e2e_screenshot, never a desktop capture) are named mcs-<shot>-<dark|light>.png. The server is the fixture of
// crates/mcp/tests/fixtures (FX.mcpFixture, set by the harness once the backend exists); any absolute path works against the browser mock.
const CANARY = "CANARY-MCP-7f3a-ui";
const NAME = "ui-fixture";
const SERVER_SCRIPT = (typeof FX !== "undefined" && FX.mcpFixture) || "/opt/intely-mcp-fixture/mcp-fixture-server.mjs";

const pane = () => q(".settings__pane");
const dialogOf = (title) => qa('[role="dialog"], [role="alertdialog"]').find((d) => text(q("h2", d)) === title);
const rowOf = (name) => qa(".mcp-row").find((r) => text(q(".mcp-name", r)) === name);
const fieldByLabel = (root, label) => qa("input, textarea", root).find((i) => i.id && text(q(`label[for="${i.id}"]`, root)) === label);
const hasEmptyState = () => qa(".ui-empty", pane()).some((e) => /No MCP servers yet/.test(text(e)));
const leaks = () => [document.documentElement.outerHTML, ...qa("input, textarea").map((i) => i.value)].some((s) => s.includes(CANARY));

async function setSelect(el, value) {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(150);
}

/** Dark and light, ending on dark: the same pair of frames for every shot. */
async function shotBoth(name) {
  const files = [];
  for (const theme of ["dark", "light"]) {
    document.documentElement.setAttribute("data-theme", theme);
    await sleep(900);
    files.push(await window.__e2e.screenshot(name));
  }
  document.documentElement.setAttribute("data-theme", "dark");
  await sleep(300);
  return files;
}

async function closeDialog(title, buttonLabel = "Cancel") {
  const d = dialogOf(title);
  await clickButton(buttonLabel, d);
  await waitFor(() => !dialogOf(title), { what: `the "${title}" dialog to close` });
  await sleep(150);
}

async function openRowMenu(name, item) {
  const row = await waitFor(() => rowOf(name), { what: `the row of ${name}` });
  await clickButton(`Actions for ${name}`, row);
  const entry = await waitFor(() => qa('[role="menuitem"]').find((i) => text(i).startsWith(item)), { what: `the menu item ${item}` });
  entry.click();
  await sleep(200);
}

await window.__e2e.resize(1440, 900);
await waitFor(() => q(".shell__body") && !q(".splash"), { what: "the workspace shell", timeout: 30000 });
calmMotion(true);
await sleep(700);

step("open the section");
await press(",", { meta: true });
const settings = await waitFor(() => q(".settings"), { what: "Settings" });
(await waitFor(() => qa(".settings__item", settings).find((b) => /^MCP servers$/.test(text(b))), { what: "the MCP servers section" })).click();
await waitFor(() => q(".mcp") && !q(".mcp__loading"), { what: "the MCP section to load", timeout: 20000 });
await sleep(400);
check("the section is titled MCP servers", /^MCP servers$/.test(text(q(".settings__title"))), text(q(".settings__title")));

step("empty state");
const startedEmpty = hasEmptyState();
if (startedEmpty) {
  const add = findButton("Add server", pane());
  check("empty: Add server is the one primary button", !!add && add.getAttribute("data-variant") === "primary");
  check("empty: Import from Claude Code is offered, as a secondary button", findButton("Import from Claude Code...", pane())?.getAttribute("data-variant") === "secondary");
  notes.empty = await shotBoth("empty");
} else {
  skip("empty state", "the data directory already has MCP servers");
}

step("add a server");
await clickButton("Add server", pane());
let editor = await waitFor(() => dialogOf("Add MCP server"), { what: "the editor" });
await typeInto(fieldByLabel(editor, "Name"), NAME);
await typeInto(fieldByLabel(editor, "Command"), "node");
await typeInto(fieldByLabel(editor, "Arguments"), SERVER_SCRIPT);
await clickButton("Add variable", editor);
await typeInto(q('[aria-label="Name of entry 1"]', editor), "FIXTURE_TOKEN");
const lock = await waitFor(() => q('input[type="checkbox"][aria-label="FIXTURE_TOKEN is a secret"]', editor), { what: "the Secret box of FIXTURE_TOKEN" });
check("a name like FIXTURE_TOKEN ticks and locks the Secret box", lock.checked && lock.disabled);
const secretField = await waitFor(() => q('input[type="password"]', editor), { what: "the secret field" });
await typeInto(secretField, CANARY);
await clickButton("Add variable", editor);
await typeInto(q('[aria-label="Name of entry 2"]', editor), "FIXTURE_MODE");
await typeInto(await waitFor(() => q('[aria-label="Value of FIXTURE_MODE"]', editor), { what: "the value of FIXTURE_MODE" }), "ok");
await sleep(300);
notes.editor = await shotBoth("editor");

step("save and test: the confirm dialog gates the Test");
await clickButton("Save and test", editor);
const confirm = await waitFor(() => dialogOf("Run this program?"), { what: "the confirm dialog" });
check("the confirm dialog is an alertdialog", confirm.getAttribute("role") === "alertdialog");
await waitFor(() => document.activeElement === findButton("Cancel", confirm), { what: "Cancel to have the focus", timeout: 4000 }).catch(() => {});
check("Cancel has the initial focus of the confirm dialog", document.activeElement === findButton("Cancel", confirm), document.activeElement?.outerHTML?.slice(0, 120));
check("the confirm dialog lists the arguments one by one", qa(".mcp-args__item", confirm).length === 1 && text(q(".mcp-args__item", confirm)) === SERVER_SCRIPT, text(q(".mcp-args", confirm)));
check("the confirm dialog shows a plain variable and tags the secret, without its value", /FIXTURE_MODE\s*=\s*ok/.test(text(confirm)) && /FIXTURE_TOKEN\s*secret/.test(text(confirm)) && !text(confirm).includes(CANARY), text(confirm).slice(0, 400));
check("Confirm and test is the one primary button", findButton("Confirm and test", confirm)?.getAttribute("data-variant") === "primary");
notes.confirm = await shotBoth("confirm");

step("confirm and test");
await clickButton("Confirm and test", confirm);
await waitFor(() => !dialogOf("Run this program?"), { what: "the confirm dialog to close" });
const row = await waitFor(() => rowOf(NAME), { what: `the row of ${NAME}` });
const panel = await waitFor(() => q(".mcp-test__ok", row), { what: "the Test result", timeout: 30000 });
check("the Test result says it connected", /Connected in/.test(text(panel)), text(panel));
const toolRow = (tool) => qa("tr[data-tool]", row).find((r) => r.getAttribute("data-tool") === tool);
await waitFor(() => toolRow("echo") && toolRow("write_note") && toolRow("mystery"), { what: "the three fixture tools", timeout: 15000 });
check("echo is marked as only reading, by the server", /Only reads/.test(text(toolRow("echo"))));
check("write_note is marked as changing things", /Changes things/.test(text(toolRow("write_note"))));
check("mystery is not stated", /Not stated/.test(text(toolRow("mystery"))));
check("the Resources row has a rule of its own", !!toolRow("resources"));
const blocked = toolRow("git_commit");
if (blocked) {
  check("a tool that looks like a commit is blocked by default, with Deny", /Blocked by default/.test(text(blocked)) && q("select", blocked)?.value === "deny", text(blocked));
} else {
  skip("blocked by default", "the server has no git_commit tool");
}
check("the row is Ready and On by default is on", /Ready/.test(text(row)) && q('[role="switch"]', row)?.getAttribute("aria-checked") === "true", text(row).slice(0, 200));
notes["test-ok"] = await shotBoth("test-ok");

step("rules");
const ruleOf = (tool) => q(`select[aria-label="Rule for ${tool}"]`, row);
const keepRisky = toolRow("api_key_rotate");
if (keepRisky) {
  await setSelect(ruleOf("api_key_rotate"), "deny");
  await waitFor(() => ruleOf("api_key_rotate")?.value === "deny", { what: "the Deny rule of api_key_rotate" });
}
await setSelect(ruleOf("write_note"), "ask");
await waitFor(() => ruleOf("write_note")?.value === "ask", { what: "the Ask rule of write_note" });
check("a rule is one Select per tool and sticks after the list is read again", ruleOf("write_note")?.value === "ask");
const group = q('[role="radiogroup"][aria-label="For tools without their own rule"]', row);
qa('[role="radio"]', group).find((r) => text(r) === "Deny").click();
await waitFor(() => qa('[role="radio"]', q('[role="radiogroup"][aria-label="For tools without their own rule"]', row)).find((r) => text(r) === "Deny")?.getAttribute("aria-checked") === "true", { what: "the default rule Deny" });
qa('[role="radio"]', q('[role="radiogroup"][aria-label="For tools without their own rule"]', row)).find((r) => text(r) === "Ask").click();
await waitFor(() => qa('[role="radio"]', q('[role="radiogroup"][aria-label="For tools without their own rule"]', row)).find((r) => text(r) === "Ask")?.getAttribute("aria-checked") === "true", { what: "the default rule Ask again" });
check("the default rule can be changed and changed back", /Default: Ask/.test(text(row)), text(row).slice(0, 200));

step("canary scan");
check("the typed secret is nowhere in the page", !leaks());
const listed = await invoke("mcp_list", {}).catch(() => null);
if (listed) check("mcp_list never carries the secret", !JSON.stringify(listed).includes(CANARY));
else skip("mcp_list scan", "no backend command in this build");

step("edit: the stored secret is masked");
await openRowMenu(NAME, "Edit");
editor = await waitFor(() => dialogOf(`Edit ${NAME}`), { what: "the edit dialog" });
check("a stored secret shows a mask and the Keychain badge", !!q('[role="img"][aria-label^="Stored in the Keychain"]', editor) && /Stored in the Keychain/.test(text(editor)), text(editor).slice(0, 300));
check("a stored secret has no field to read it from", qa('input[type="password"]', editor).length === 0 && !leaks());
check("a stored secret can be replaced", !!findButton("Replace: FIXTURE_TOKEN", editor));
await closeDialog(`Edit ${NAME}`);

step("import dialog");
const more = await waitFor(() => findButton("More ways to add a server", pane()), { what: "the Add server menu" });
more.click();
(await waitFor(() => qa('[role="menuitem"]').find((i) => text(i).startsWith("Import from Claude Code")), { what: "the import item" })).click();
await waitFor(() => dialogOf("Import from Claude Code"), { what: "the import dialog" });
check("the import dialog explains what is read", /Only its list of MCP servers is read/.test(text(dialogOf("Import from Claude Code"))));
notes.import = await shotBoth("import");
await closeDialog("Import from Claude Code");

step("a changed command needs confirmation again");
await openRowMenu(NAME, "Edit");
editor = await waitFor(() => dialogOf(`Edit ${NAME}`), { what: "the edit dialog" });
const args = fieldByLabel(editor, "Arguments");
await typeInto(args, `${args.value}\n--ui-e2e-changed`);
await clickButton("Save", editor);
await waitFor(() => !dialogOf(`Edit ${NAME}`), { what: "the edit dialog to close" });
await waitFor(() => /Needs confirmation/.test(text(rowOf(NAME) ?? document.body)), { what: "the row to need confirmation" });
check("an edited command needs confirmation again and says why", /Changed since you confirmed it/.test(text(rowOf(NAME))), text(rowOf(NAME)).slice(0, 300));
check("the typed secret was kept: the row is not 'Secret missing'", !/Secret missing/.test(text(rowOf(NAME))));

step("the switch is gated by the dialog");
const sw = () => q(`[role="switch"][aria-label="On by default: ${NAME}"]`, rowOf(NAME));
if (sw().getAttribute("aria-checked") === "true") sw().click();
await waitFor(() => sw().getAttribute("aria-checked") === "false", { what: "the switch to go off" });
sw().click();
await waitFor(() => dialogOf("Run this program?"), { what: "the confirm dialog for the switch" });
await closeDialog("Run this program?");
check("cancelling the dialog leaves the switch off", sw().getAttribute("aria-checked") === "false");
sw().click();
await waitFor(() => dialogOf("Run this program?"), { what: "the confirm dialog again" });
await clickButton("Confirm", dialogOf("Run this program?"));
await waitFor(() => !dialogOf("Run this program?"), { what: "the dialog to close" });
await waitFor(() => sw().getAttribute("aria-checked") === "true", { what: "the switch to go on after the confirmation" });
check("confirming switches it on and the row is Ready again", /Ready/.test(text(rowOf(NAME))), text(rowOf(NAME)).slice(0, 200));

step("remove");
await openRowMenu(NAME, "Remove");
const ask = await waitFor(() => dialogOf(`Remove ${NAME}?`), { what: "the remove dialog" });
check("removing names what is deleted", /stored secrets are deleted/.test(text(ask)));
await clickButton("Remove", ask);
await waitFor(() => !rowOf(NAME), { what: "the row to disappear" });
check("the removed server is gone from the list", !rowOf(NAME));
check("the canary is still nowhere in the page", !leaks());
if (startedEmpty) {
  await waitFor(() => hasEmptyState(), { what: "the empty state to come back" });
  check("with the last server gone the empty state is back", true);
}

await finish();
