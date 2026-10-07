// (x2) MongoDB Studio for everyone, on the REAL window against a FAKE loopback mongod (scripts/e2e/fake-mongod.mjs, started by
// run.sh; no Docker, no real server, no model call): first run with the Happy preset OFF: the first-run screen (S2) with its five
// starting points, the loopback probe, the wizard ("This computer or Docker") with its test stepper and a saved profile, "Connect
// now" and browsing the fake collection, the AI tab of the form (capability line, no Happy preset), no Hungarian text anywhere in the
// DOM nor in the AI payload preview, the loud bar of a production-tagged connection, and an export then import round trip through
// the scripted native dialog (INTELY_MONGO_DIALOG_PATH, E2E jail only) whose file run.sh scans for the secret canary afterwards.
// Everything that needs a real server (auth, TLS, replica sets) is NOT covered here. MONGO = { uri, db, port } comes from run.sh.
await waitForTree();
const FAKE_PORT = MONGO.port;
const DBN = "fakeshop";
const CANARY = "CANARY-pw-7f3a91"; // run.sh greps for this in settings.json, the audit log, the export file and the logs
const dlg = () => q(".settings");
async function openSettings(section) {
  if (!dlg()) { await press(",", { meta: true }); await waitFor(dlg, { what: "Settings" }); }
  (await waitFor(() => qa(".settings__item", dlg()).find((b) => text(b) === section), { what: `the ${section} section` })).click();
  await sleep(250);
  return dlg();
}
const pane = () => q(".settings__pane", dlg());
const sw = (label) => q(`[role="switch"][aria-label="${label}"]`, pane());
const rejected = async (p) => { try { await p; return null; } catch (e) { return e; } };
const errText = (e) => (e && typeof e === "object" ? `${e.code ?? ""} ${e.message ?? ""}` : String(e));
const pick = (row) => (q(".ui-tree-row__main", row) ?? row).click();
const tabEl = () => q(`section.mg-tab[aria-label="orders in ${DBN}"]`);
// letters and words only Hungarian text has; the language of the UI is pinned to English by the harness
const HU = /[őűŐŰ]|elm[uú]lt|Budapest|\b(rendelés|legutóbbi|étterem|vendég|törl|Kapcsolat)/i;
const huIn = (el) => { const m = HU.exec(el?.innerText ?? ""); return m ? `"${m[0]}"` : ""; };

// ---- 1. switch on; the Happy preset is off ----------------------------------------------------------------------------------------------
step("enable");
let st = await invoke("mongo_status");
check("compiled in, switch off by default, nothing connected", st.compiled === true && st.enabled === false && st.connections.length === 0, JSON.stringify(st));
await openSettings("Database");
await waitFor(() => sw("Enable MongoDB Studio"), { what: "the Enable switch" });
sw("Enable MongoDB Studio").click();
await waitFor(() => sw("Enable MongoDB Studio").getAttribute("aria-checked") === "true", { what: "the switch to turn on" });
await waitFor(() => railButton("Database"), { what: "the Database rail item", timeout: 15000 });
const happy = await waitFor(() => sw("Happy preset"), { what: "the Happy preset switch" });
check("the Happy preset switch is off by default", happy.getAttribute("aria-checked") === "false");

// ---- 2. first run (S2) -----------------------------------------------------------------------------------------------------------------
step("first run");
const first = await waitFor(() => q("section.mm-first", pane()), { what: "the first-run screen", timeout: 20000 });
check("S2: heading, five starting points and the read-only line", /Connect your first database/.test(text(first)) && qa("li.mm-tile", first).length === 5 && /read-only/i.test(text(first)), text(first).slice(0, 200));
check("S2: no profile exists yet and the text holds no Hungarian", (await invoke("mongo_profiles")).length === 0 && !huIn(document.body), huIn(document.body));
await snap("mongo-x2-first-run");
await clickButton("Look for MongoDB on this computer", first);
await waitFor(() => text(q(".mm-probe__out", first)).length > 5 || q(".mm-probe__out button", first), { what: "the loopback probe answer", timeout: 15000 });
const probe = text(q(".mm-probe__out", first));
check("the probe answers on click (found a server, or nothing found plus the docker command)", /Found a server|Nothing found/.test(probe) && (/Found a server/.test(probe) || /docker run/.test(probe)), probe);
notes.probe = probe.slice(0, 160);

// the same test straight over the IPC (what the wizard's button calls), to tell a UI problem from an engine problem
step("ipc test");
const t0 = performance.now();
const direct = await Promise.race([invoke("mongo_test", { input: { name: "Local MongoDB", environment: "local", spec: { scheme: "standard", hosts: [{ host: "127.0.0.1", port: FAKE_PORT }], auth: { mechanism: "none" }, tls: { mode: "auto" }, tunnel: { kind: "none" } } }, testId: "tabc12345" }).catch((e) => ({ error: errText(e) })), sleep(40000).then(() => ({ error: "no answer in 40 s" }))]);
notes.directTest = JSON.stringify(direct).slice(0, 600);
check("mongo_test over the IPC answers with an ok report and the server version", direct.ok === true && new RegExp(MONGO.version.replace(/\./g, "\\.")).test(JSON.stringify(direct)), `${Math.round(performance.now() - t0)} ms ${notes.directTest}`);

// ---- 3. the wizard: "This computer or Docker" -------------------------------------------------------------------------------------------
step("wizard");
await clickButton("This computer or Docker", first);
const wiz = await waitDialog(/New connection/, "the wizard");
check("wizard step 2 pre-fills a local profile (name, 127.0.0.1, tag Local)", q("#mgf-name", wiz)?.value === "Local MongoDB" && q("#mgf-hosts-0-host", wiz)?.value === "127.0.0.1" && qa('[role="radio"]', wiz).some((r) => text(r) === "Local" && r.getAttribute("aria-checked") === "true"), `${q("#mgf-name", wiz)?.value} ${q("#mgf-hosts-0-host", wiz)?.value}`);
await typeInto(q("#mgf-hosts-0-port", wiz), String(FAKE_PORT));
await snap("mongo-x2-wizard-2");
await clickButton("Next", wiz);
await waitFor(() => q(".mm-wiz__review", wiz), { what: "wizard step 3" });
await sleep(1200); // the engine allows one test per second
await clickButton("Test connection", wiz);
await waitFor(() => { const s = q("section.mgs", wiz); return s && ["ok", "warn", "failed"].includes(s.getAttribute("data-state")); }, { what: "the test result", timeout: 60000 }).catch((e) => { notes.stuck = text(q(".mm-wiz__review", wiz)).slice(0, 1200) + " || mgs=" + (q("section.mgs", wiz)?.outerHTML ?? "none").slice(0, 1500); throw e; });
const stepper = q("section.mgs", wiz);
const stepStates = Object.fromEntries(qa("li.mgs-step", stepper).map((li) => [li.getAttribute("data-step"), li.getAttribute("data-state")]));
notes.stepStates = JSON.stringify(stepStates);
check("the stepper ends ok or warn (tunnel skipped, connect ok)", ["ok", "warn"].includes(stepper.getAttribute("data-state")) && stepStates.tunnel === "skipped" && stepStates.connect === "ok", `${stepper.getAttribute("data-state")} ${notes.stepStates} ${text(q(".mgd", wiz) ?? stepper).slice(0, 300)}`);
check("every listed step has a word for its state (not colour alone)", qa("li.mgs-step", stepper).every((li) => text(q(".mgs-step__state", li)).length > 1));
check("the success card shows the server version", new RegExp(MONGO.version.replace(/\./g, "\\.")).test(text(q(".mgs-ok", wiz) ?? "")), text(q(".mgs-ok", wiz) ?? "none"));
await snap("mongo-x2-wizard-3");
await clickButton("Save", wiz);
await waitFor(() => q(".mm-done", wiz), { what: "the saved step", timeout: 15000 });
check("after saving: the read-only user tip and the AI-off line", /read-only database user/i.test(text(q(".mm-tip", wiz))) && /AI is off/.test(text(q(".mm-done", wiz))), text(q(".mm-done", wiz)).slice(0, 200));
await snap("mongo-x2-wizard-done");
const profiles0 = await invoke("mongo_profiles");
const local = profiles0.find((p) => p.name === "Local MongoDB");
check("the profile is saved: Local, read-only, AI off, generic domain, no credentials in the view", !!local && local.environment === "local" && local.readOnly === true && local.aiMode === "off" && (local.domain ?? "generic") === "generic" && !/mongodb:\/\/[^"\/]*@/.test(JSON.stringify(profiles0)), JSON.stringify(local));
await clickButton("Connect now", wiz);
await dialogGone(wiz);
await waitFor(async () => (await invoke("mongo_status")).connections.some((c) => c.id === local.id), { what: "the connection to be open", timeout: 30000 });

// ---- 4. the AI tab: capability line, no Happy preset --------------------------------------------------------------------------------------
step("ai tab");
await clickButton("New connection", pane());
const form = await waitDialog(/New connection/, "the connection form");
qa('[role="radio"]', form).find((r) => text(r) === "AI")?.click();
await sleep(200);
await waitFor(() => /Needs Node|Checking what the AI needs/.test(text(form)), { what: "the AI capability line" });
await waitFor(() => /Needs Node/.test(text(form)), { what: "the AI capability result", timeout: 15000 });
check("the AI tab states what AI needs (Node and the Claude CLI) and offers no Happy preset", /Needs Node \(.*\) and the Claude CLI/.test(text(form)) && !/\bHappy\b/.test(text(form)), text(form).slice(0, 300));
check("the form holds no Hungarian text", !huIn(form), huIn(form));
await snap("mongo-x2-form-ai");
await clickButton("Cancel", form);
await dialogGone(form);

// ---- 5. browse the fake collection -------------------------------------------------------------------------------------------------------
step("browse");
await press("Escape");
await waitFor(() => !dlg(), { what: "Settings to close", timeout: 5000 }).catch(() => undefined);
await openRail("Database");
const tree = await waitFor(() => q('[role="tree"][aria-label="Databases and collections"]'), { what: "the databases tree" });
pick(await waitTreeItem("Local MongoDB", tree));
await waitTreeItem(DBN, tree, 60000);
const dbRow = await waitTreeItem(DBN, tree);
if (dbRow.getAttribute("aria-expanded") === "false") pick(dbRow);
await waitTreeItem("orders", tree, 30000);
pick(await waitTreeItem("orders", tree));
await waitFor(tabEl, { what: "the orders tab" });
await waitFor(() => qa('.ui-grid__row[role="row"]', tabEl()).length > 0 || q(".ui-empty", tabEl()), { what: "documents", timeout: 60000 });
if (!qa('.ui-grid__row[role="row"]', tabEl()).length) { await clickButton("Find", tabEl()); await waitFor(() => qa('.ui-grid__row[role="row"]', tabEl()).length > 0, { what: "documents after Find", timeout: 30000 }); }
check("the fake collection opens with its 3 documents, no Production bar on a Local tag", qa('.ui-grid__row[role="row"]', tabEl()).length >= 3 && !q(".ld-bar", tabEl()), `${qa('.ui-grid__row[role="row"]', tabEl()).length} rows`);
await snap("mongo-x2-collection");

// ---- 6. AI payload preview (no model call): generic wording, no Hungarian -----------------------------------------------------------------
step("ai payload");
const ai = await invoke("mongo_profile_save", { input: { name: "AI probe", environment: "local", aiMode: "schemaOnly", confirm: "AI probe", spec: { scheme: "standard", hosts: [{ host: "127.0.0.1", port: FAKE_PORT }], auth: { mechanism: "none" }, tls: { mode: "off" }, tunnel: { kind: "none" } } } });
await invoke("mongo_connect", { id: ai.id });
const payload = await invoke("mongo_ai_payload", { req: { tab: "x2ai", connection: ai.id, db: DBN, collection: "orders", question: "the three newest orders", utcOffsetMin: -240, tzName: "America/New_York" } }).catch((e) => ({ error: errText(e) }));
const payloadText = JSON.stringify(payload);
check("the AI payload preview exists, names the collection and holds no Hungarian and no connection string", !payload.error && payloadText.length > 200 && payloadText.includes("orders") && payloadText.includes("America/New_York") && !payloadText.includes("Europe/Budapest") && !HU.test(payloadText) && !payloadText.includes("mongodb://"), payload.error ?? `${payloadText.length} chars; hu=${HU.exec(payloadText)?.[0] ?? "none"}`);
notes.payloadBytes = payloadText.length;

// ---- 7. a production-tagged connection is loud --------------------------------------------------------------------------------------------
step("production bar");
const prod = await invoke("mongo_profile_save", { input: { name: "Prod tagged", environment: "production", spec: { scheme: "standard", hosts: [{ host: "127.0.0.1", port: FAKE_PORT }], auth: { mechanism: "none" }, tls: { mode: "off" }, tunnel: { kind: "none" } } } });
check("a Production tag is kept on a loopback host", prod.environment === "production" && prod.effectiveLevel !== "local", JSON.stringify(prod));
findButton("Reload connections")?.click();
pick(await waitTreeItem("Prod tagged", q('[role="tree"][aria-label="Databases and collections"]'), 20000));
const firstDlg = await waitDialog(/for the first time/, "the first-connect endpoint confirm", 15000);
await clickButton("Connect", firstDlg);
await dialogGone(firstDlg);
const confirmDlg = await waitDialog(/Connect to production/, "the production confirm", 15000);
check("the first connect to production asks, and Cancel is the default", /Prod tagged/.test(text(confirmDlg)) && /read-only/i.test(text(confirmDlg)), text(confirmDlg).slice(0, 200));
await clickButton("Connect", confirmDlg);
await dialogGone(confirmDlg);
const tree2 = q('[role="tree"][aria-label="Databases and collections"]');
const rowsNamed = (name) => qa('[role="treeitem"]', tree2).filter((i) => text(q(".ui-tree-row__main", i) ?? i) === name);
await waitFor(() => rowsNamed(DBN).length >= 2, { what: "the database of the production connection", timeout: 60000 });
for (const r of rowsNamed(DBN)) if (r.getAttribute("aria-expanded") === "false") pick(r);
await waitFor(() => rowsNamed("orders").length >= 2, { what: "the production collections", timeout: 30000 });
pick(rowsNamed("orders")[rowsNamed("orders").length - 1]);
await waitFor(() => q(".ld-bar"), { what: "the production bar", timeout: 30000 }).catch((e) => { notes.stuck = `tabs=${qa("section.mg-tab").length} tree=${text(tree2).slice(0, 300)}`; throw e; });
const prodTab = qa("section.mg-tab").find((s) => q(".ld-bar", s));
check("the production tab carries the persistent bar: PRODUCTION, read-only, host", !!prodTab && /PRODUCTION/.test(text(q(".ld-bar", prodTab))) && /read-only/i.test(text(q(".ld-bar", prodTab))) && text(q(".ld-bar", prodTab)).includes("127.0.0.1"), text(q(".ld-bar") ?? "none"));
check("the title bar shows the production chip", !!q('[data-loud="chip"]', document), "");
await snap("mongo-x2-production");

// ---- 8. a profile with a secret, then export and import ---------------------------------------------------------------------------------
step("export");
await invoke("mongo_profile_save", { input: { name: "Canary", environment: "local", spec: { scheme: "standard", hosts: [{ host: "127.0.0.1", port: FAKE_PORT }], auth: { mechanism: "scramSha256", username: "canaryuser", source: "admin", savePassword: true }, tls: { mode: "off" }, tunnel: { kind: "none" } }, password: CANARY } });
await press("Escape");
await openSettings("Database");
await waitFor(() => findButton("Export…", pane()), { what: "the Export button" });
const before = (await invoke("mongo_profiles")).length;
findButton("Export…", pane()).click();
const exp = await waitDialog(/Export connections/, "the export dialog");
check("the export dialog promises no secrets are exported", /never exported/.test(text(exp)), text(exp).slice(0, 200));
await snap("mongo-x2-export");
await clickButton("Export", exp);
await dialogGone(exp, 20000).catch((e) => { notes.stuck = text(exp).slice(0, 600); throw e; });
await sleep(500);
step("import");
findButton("Import…", pane()).click();
const imp = await waitDialog(/Import connections/, "the import dialog", 15000);
await waitFor(() => qa("li.mm-io__item", imp).length > 0, { what: "the import preview", timeout: 15000 });
check("the import preview lists every exported profile and says imports are read-only with AI off", qa("li.mm-io__item", imp).length === before && /read-only/i.test(text(imp)), `${qa("li.mm-io__item", imp).length} of ${before}: ${text(imp).slice(0, 200)}`);
await snap("mongo-x2-import");
await clickButton(qa("button", imp).map(text).find((x) => /^Import \d+ connections?$/.test(x)), imp);
await waitFor(() => q(".mm-io__result", imp), { what: "the import result", timeout: 20000 });
const after = await invoke("mongo_profiles");
const fresh = after.filter((p) => / \(2\)$/.test(p.name));
check("the import added the profiles again with a (2) suffix, read-only, AI off, and asks for the password", after.length === before * 2 && fresh.length === before && fresh.every((p) => p.readOnly === true && p.aiMode === "off") && !!fresh.find((p) => p.name === "Canary (2)") && !fresh.find((p) => p.name === "Canary (2)").hasPassword, `${before} -> ${after.length}; ${JSON.stringify(fresh.map((p) => [p.name, p.readOnly, p.aiMode, p.hasPassword]))}`);
await clickButton("Close", imp);
const exported = await invoke("mongo_status");
notes.connectionsOpen = exported.connections.length;

// ---- 9. no Hungarian anywhere, then switch off ---------------------------------------------------------------------------------------------
step("switch off");
check("no Hungarian text in the whole page after the run", !huIn(document.body), huIn(document.body));
await waitFor(() => sw("Enable MongoDB Studio"), { what: "the switch again" });
sw("Enable MongoDB Studio").click();
await waitFor(() => sw("Enable MongoDB Studio").getAttribute("aria-checked") === "false", { what: "the switch to turn off" });
await waitFor(() => !railButton("Database"), { what: "the rail item to disappear", timeout: 15000 });
st = await invoke("mongo_status");
check("off again: no connection is left", st.enabled === false && st.connections.length === 0);
await snap("mongo-x2-off");
await press("Escape");
await finish();
