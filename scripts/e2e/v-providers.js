// (v) Settings > Providers (detect, Test connection, the Experimental providers switch, an API key typed once, kept in the in-memory store, removed),
// Settings > Roles (edit a role, Save: the file lands in the fixture's agents dir and the old one in the backup dir), and Rewind
// from the UI (Inspect run > Rewind...: snapshot list, dry-run file list, typed confirmation, restore). No model call anywhere:
// Test connection is a `--version` probe, the run is the mock provider. The Keychain is not used under the harness by design.
await waitForTree();
const dlgOf = () => q(".settings");
async function openSettings(section) {
  if (!dlgOf()) { await press(",", { meta: true }); await waitFor(dlgOf, { what: "Settings" }); }
  (await waitFor(() => qa(".settings__item", dlgOf()).find((b) => text(b) === section), { what: `the ${section} section` })).click();
  await sleep(200);
  return dlgOf();
}
const pane = () => q(".settings__pane", dlgOf());
const card = (name) => qa("article.pcard", pane()).find((a) => text(q(".pcard__name", a)) === name);

step("providers");
// ---- Providers: detect + Test --------------------------------------------------------------------------------------------------------------
await openSettings("Providers");
// Wave4: only Claude exists until the global "Experimental providers" switch is on
await waitFor(() => qa("article.pcard", pane()).length === 1, { what: "Claude only (experimental providers are off by default)", timeout: 30000 });
await waitFor(() => /Ready/i.test(text(card("Claude"))) && /\d+\.\d+/.test(text(card("Claude"))), { what: "Claude detected (version shown)", timeout: 30000 });
check("Detect: the real claude CLI is found and the card shows version and program path", /Version\s*\d+\.\d+/.test(text(card("Claude"))) && /Program\s*\//.test(text(card("Claude"))), text(card("Claude")).slice(0, 240));
check("Detect: the overview counts the providers that are on", /1\s*of\s*8\s*providers on/.test(text(q(".providers__overview", pane())).replace(/\s+/g, " ")), text(q(".providers__overview", pane())));
await clickButton("Test connection", card("Claude"));
await waitFor(() => /Works: claude/.test(text(card("Claude"))), { what: "Test connection to work for Claude", timeout: 30000 });
check("Test connection (Claude): 'Works' with the CLI path and a latency", /Works: claude \S+ at \//.test(text(card("Claude"))) && /\(\d+ ms\)/.test(text(card("Claude"))), text(q(".pcard__result", card("Claude"))));
step("experimental providers");
// the global switch is off by default and names what it hides; on, the seven others exist; a program that is not installed cannot be switched on
const expSwitch = () => q('[role="switch"][aria-label="Experimental providers"]', pane());
check("Experimental providers is off by default", expSwitch()?.getAttribute("aria-checked") === "false", String(expSwitch()?.getAttribute("aria-checked")));
check("the zero-cost note names the hidden providers", /7 more providers are available once this is on: Codex, Gemini/.test(text(pane())), text(pane()).slice(0, 400));
expSwitch().click();
await waitFor(() => qa("article.pcard", pane()).length === 8, { what: "eight provider cards with Experimental providers on", timeout: 30000 });
check("the eight real providers are listed (no mock-only cards)", ["Claude", "Codex", "Gemini", "GitHub Copilot", "OpenCode", "Goose", "Qwen Code", "ACP agent"].every((n) => card(n)), qa("article.pcard", pane()).map((a) => text(q(".pcard__name", a))).join(","));
// Goose is not installed on this machine: the switch is disabled and the card says why (an experimental provider is never silently half-on)
const goose = () => card("Goose");
await waitFor(() => /not installed on this machine/.test(text(goose())), { what: "Goose to be detected as not installed", timeout: 30000 });
check("a provider whose program is missing cannot be switched on", q('[role="switch"][aria-label="Enable Goose"]', goose())?.disabled === true || q('[role="switch"][aria-label="Enable Goose"]', goose())?.getAttribute("aria-disabled") === "true", text(goose()).slice(0, 200));
check("the custom ACP agent card exists and needs a command line", !!card("ACP agent"));
await snap("providers-experimental");
expSwitch().click();
await waitFor(() => qa("article.pcard", pane()).length === 1, { what: "back to Claude only", timeout: 15000 });
check("Switching Experimental providers off hides every other card again", true);

step("api key");
// ---- the API key: typed once, masked, never shown, removed ----------------------------------------------------------------------------
const claudeSel = () => q('select[aria-label="Claude sign-in"]', card("Claude"));
claudeSel().value = "apiKey";
claudeSel().dispatchEvent(new Event("change", { bubbles: true }));
const keyInput = await waitFor(() => q('input[aria-label="API key"]', card("Claude")), { what: "the API key field", timeout: 15000 });
check("the key field is a password field", keyInput.type === "password", keyInput.type);
const SECRET = "sk-ant-e2e-0000000000-not-a-real-key";
await typeInto(keyInput, SECRET);
await clickButton("Save", card("Claude"));
await waitFor(() => q('[role="img"][aria-label="API key stored"]', card("Claude")), { what: "the stored mask", timeout: 15000 });
check("Secret set: the field turns into a mask and the key text is nowhere in the page", !document.body.innerText.includes(SECRET) && !qa("input").some((i) => i.value === SECRET));
check("Secret has: the in-memory store reports it", (await invoke("secrets_has", { key: "providers.claude:default" })) === true);
await snap("providers-key");
await clickButton("Remove", card("Claude"));
await clickButton("Remove API key", card("Claude"));
await waitFor(() => q('input[aria-label="API key"]', card("Claude")), { what: "the empty key field after Remove", timeout: 15000 });
check("Secret remove: the store no longer has it and the field is back", (await invoke("secrets_has", { key: "providers.claude:default" })) === false);
claudeSel().value = "subscription";
claudeSel().dispatchEvent(new Event("change", { bubbles: true }));
await waitFor(() => !q('input[aria-label="API key"]', card("Claude")), { what: "back on the CLI sign-in", timeout: 15000 });

step("roles");
// ---- Roles: edit + Save with backup ----------------------------------------------------------------------------------------------------
await openSettings("Roles");
await waitFor(() => qa('input[aria-label="Role name"]', pane()).length >= 2, { what: "the roles table", timeout: 30000 });
const roleNames = qa('input[aria-label="Role name"]', pane()).map((i) => i.value);
notes.roles = roleNames.join(",");
check("Roles: the fixture's own agents dir is what the table lists", roleNames.includes("developer") && roleNames.includes("reviewer"), roleNames.join(","));
const devRow = () => qa('input[aria-label="Role name"]', pane()).find((i) => i.value === "developer")?.closest("tbody");
const permSel = () => q('select[aria-label="Permission mode"]', devRow());
const modelSel = () => q('select[aria-label="Model"]', devRow());
const firstModel = qa("option", modelSel()).map((o) => o.value).find((v) => v);
if (firstModel) { modelSel().value = firstModel; modelSel().dispatchEvent(new Event("change", { bubbles: true })); } // the fixture's `sonnet` is not an id the provider offers
const before = permSel().value;
notes.permBefore = before;
const options = qa("option", permSel()).map((o) => o.value);
const target = options.find((o) => o !== before && o !== "readOnly" && o !== "plan") ?? options[0];
notes.permOptions = options.join(",");
permSel().value = target;
permSel().dispatchEvent(new Event("change", { bubbles: true }));
await waitFor(() => findButton("Save", devRow()) && !findButton("Save", devRow()).disabled, { what: "the row's Save button (the role is dirty and valid)", timeout: 10000 });
check("An edit marks the role dirty and counts the unsaved change", /1 unsaved change/.test(text(q(".roles__count", pane()))), text(q(".roles__count", pane())));
await clickButton("Save", devRow());
const confirmDlg = await waitDialog(/Write the file of developer/, "the file-write confirmation");
check("Save asks before it changes a role file, and says a copy is kept", /copy of the current file is kept/i.test(text(confirmDlg)), text(confirmDlg).slice(0, 200));
await clickButton("Write the file", confirmDlg);
await waitFor(() => /All changes saved/.test(text(q(".roles__count", pane()))), { what: "the save to finish", timeout: 20000 });
check("Save: the table says all changes are saved", true, `permission ${before} -> ${target}`);
await snap("roles-saved");
await press("Escape");
await waitFor(() => !dlgOf(), { what: "Settings to close" });

step("rewind: agents");
// ---- Rewind from the UI --------------------------------------------------------------------------------------------------------------
await openAgents();
await newRun("mock-plain-reply", ["shop-backend"], "say hello");
await waitFor(() => runStatusText() === "Done", { what: "the mock run to finish", timeout: 60000 });
step("rewind: inspector");
const agentRuns = await invoke("runs_list");
const runId = agentRuns[0].id ?? agentRuns[0].runId;
// the run changed nothing, so make a change after it that Rewind has to take back
const rd = await invoke("files_read_file", { repoId: FX.repoIds[0], relPath: "src/lib/db.js" });
await invoke("files_write_file", { repoId: FX.repoIds[0], relPath: "src/lib/db.js", text: rd.text + "// edited after the run\n", expectedMtimeMs: rd.mtimeMs, reveal: false });
await (await waitFor(() => qa("button").find((b) => b.getAttribute("aria-label") === "Inspect run"), { what: "the Inspect run button" })).click();
const rewindBtn = await waitFor(() => findButton("Rewind…"), { what: "the Rewind… button of the Inspector", timeout: 20000 });
rewindBtn.click();
const rw = await waitFor(() => dialogsOpen().find((d) => /Rewind/.test(text(d).slice(0, 80))), { what: "the Rewind dialog" });
const snaps = await waitFor(() => { const g = q('[role="radiogroup"][aria-label="Snapshots"]', rw); return g && qa('[role="radio"]', g).length ? g : null; }, { what: "the snapshot list", timeout: 20000 });
check("Rewind: the snapshot list shows the run's snapshots (one per repo it touched)", qa('[role="radio"]', snaps).length >= 1, text(snaps).slice(0, 200));
check("Rewind: the snapshot time is recent, not 1970", !/1970/.test(text(snaps)), text(snaps).slice(0, 160));
const radio = qa('[role="radio"]', snaps)[0];
if (radio.getAttribute("aria-checked") !== "true") radio.click();
await waitFor(() => qa("ul.rewind__list", rw).length > 0 || /No files|nothing to restore|already/i.test(text(rw)), { what: "the dry-run result", timeout: 30000 });
notes.dryRun = text(rw).slice(0, 500);
check("Rewind dry-run: the file I edited after the run is listed as a change to undo", /db\.js/.test(text(rw)), text(rw).slice(0, 300));
const restoreBtn = findButton("Restore", rw) ?? qa("button", rw).find((b) => /^Restore/.test(text(b)));
check("Restore is disabled until the phrase is typed", !!restoreBtn?.disabled, restoreBtn && text(restoreBtn));
const phrase = text(q(".rewind__phrase", rw));
await typeInto(q('input[aria-label="Confirm the rewind"]', rw), phrase + "x");
check("a wrong phrase keeps it disabled", restoreBtn.disabled);
await typeInto(q('input[aria-label="Confirm the rewind"]', rw), phrase);
await snap("rewind-dryrun");
await waitFor(() => !restoreBtn.disabled, { what: "Restore to enable on the right phrase" });
restoreBtn.click();
await waitFor(() => q(".rewind__result", rw), { what: "the restore result", timeout: 30000 });
check("Rewind restore: the result lists what was restored", /db\.js/.test(text(q(".rewind__result", rw))), text(q(".rewind__result", rw)).slice(0, 200));
await snap("rewind-restored");
await finish();
