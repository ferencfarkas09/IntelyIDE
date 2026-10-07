// (x) MongoDB Studio on the REAL window against a loopback mongod fixture (docker, 127.0.0.1 only, seeded orders/customers/...):
// the zero-cost default (switch off: no rail item, no connection), enabling the module in Settings > Database, adding a loopback
// connection through the form (Test connection, AI tab P1 with the typed confirmation), browsing the seeded collection, asking in
// Hungarian (the "What is sent?" dialog first, then a reviewed draft that does NOT run by itself), running the reviewed draft,
// refusing every write (a write intent in the question, raw write commands over the IPC, $out/$merge pipelines), a non-loopback host
// shown as Production-level and refused by the jail without a socket, and switching the module off again. Real Haiku calls: 3.
// MONGO = { uri, db } comes from run.sh (the throwaway fixture's URI; it is typed into the form like a user would).
await waitForTree();
const DBN = MONGO.db;
const dlg = () => q(".settings");
async function openSettings(section) {
  if (!dlg()) { await press(",", { meta: true }); await waitFor(dlg, { what: "Settings" }); }
  (await waitFor(() => qa(".settings__item", dlg()).find((b) => text(b) === section), { what: `the ${section} section` })).click();
  await sleep(250);
  return dlg();
}
const pane = () => q(".settings__pane", dlg());
const sw = () => q('[role="switch"][aria-label="Enable MongoDB Studio"]', pane());
const status = () => invoke("mongo_status");
const rejected = async (p) => { try { await p; return null; } catch (e) { return e; } };
const errCode = (e) => (e && typeof e === "object" && "code" in e ? e.code : String(e));
const errText = (e) => (e && typeof e === "object" ? `${e.code ?? ""} ${e.message ?? ""}` : String(e));
const tabEl = () => q(`section.mg-tab[aria-label="orders in ${DBN}"]`);
const rangeText = () => text(q(".mg-docs__range", tabEl() ?? document));
const gridRows = () => qa('.ui-grid__row[role="row"]', tabEl() ?? document).length;
const askInput = () => q('input[aria-label="Ask in plain language"]', tabEl() ?? document);
// the row's click handler sits on its main label, like a user's pointer would hit it
const pick = (row) => (q(".ui-tree-row__main", row) ?? row).click();
const radioIn = (group, label, root = document) => qa(`[role="radiogroup"][aria-label="${group}"] [role="radio"]`, root).find((r) => text(r).startsWith(label));

// ---- 1. zero cost while off ----------------------------------------------------------------------------------------------------------------
step("off by default");
let st = await status();
check("compiled in, switch OFF by default, nothing connected", st.compiled === true && st.enabled === false && st.connections.length === 0, JSON.stringify(st));
check("off: no Database rail item exists", !railButton("Database"));
const offAsk = await rejected(invoke("mongo_connect", { id: "nope" }));
check("off: a connect is refused with mongoDisabled", errCode(offAsk) === "mongoDisabled", errText(offAsk));

// ---- 2. enable in Settings > Database --------------------------------------------------------------------------------------------------------
step("enable");
await openSettings("Database");
await waitFor(sw, { what: "the Enable MongoDB Studio switch" });
check("Settings > Database: the switch is off", sw().getAttribute("aria-checked") === "false");
sw().click();
await waitFor(() => sw().getAttribute("aria-checked") === "true", { what: "the switch to turn on" });
await waitFor(() => railButton("Database"), { what: "the Database rail item", timeout: 15000 });
st = await status();
check("on: the rail item appears and the studio is enabled with no connection yet", st.enabled === true && st.connections.length === 0 && !!railButton("Database"));

// ---- 3. add a loopback connection ---------------------------------------------------------------------------------------------------------
// The tabbed connection form and the wizard have their own scenario (x2); here the profile is saved through the same IPC command the form
// calls (structured spec, AI mode P1 with the typed name), so this scenario stays about browsing and the AI find against the real server.
step("new connection");
const FX_PORT = Number(new URL(MONGO.uri).port);
const FX_SPEC = { scheme: "standard", hosts: [{ host: "127.0.0.1", port: FX_PORT }], auth: { mechanism: "none" }, tls: { mode: "off" }, tunnel: { kind: "none" } };
const tested = await invoke("mongo_test", { input: { name: "E2E fixture", environment: "local", spec: FX_SPEC }, testId: "tx123456" }).catch((e) => ({ ok: false, error: errText(e) }));
check("Test connection: ok with a server version", tested.ok === true && /\d+\.\d+/.test(JSON.stringify(tested)), JSON.stringify(tested).slice(0, 300));
notes.testResult = JSON.stringify(tested).slice(0, 300);
const noConfirm = await rejected(invoke("mongo_profile_save", { input: { name: "E2E fixture", environment: "local", aiMode: "schemaOnly", spec: FX_SPEC } }));
check("lowering safety (AI on) needs the typed name: the save is refused without it", errCode(noConfirm) === "mongoConfirm", errText(noConfirm));
// the fixture is the Happy-shaped dataset (Hungarian questions): the Happy domain preset, which new profiles do not get by default and
// which the Rust side refuses while Settings > Database > Happy preset is off (Wave 5c): refused first, then the switch the Settings screen writes
const happyOff = await rejected(invoke("mongo_profile_save", { input: { name: "E2E fixture", environment: "local", domain: "happy", aiMode: "schemaOnly", confirm: "E2E fixture", spec: FX_SPEC } }));
check("the Happy preset is refused by the Rust side while its switch is off", errCode(happyOff) === "mongoInvalid" && /happyPresetOff/.test(errText(happyOff)), errText(happyOff));
await invoke("settings_set", { ns: "mongo", patch: { happyPreset: true } });
await invoke("mongo_profile_save", { input: { name: "E2E fixture", environment: "local", domain: "happy", aiMode: "schemaOnly", confirm: "E2E fixture", spec: FX_SPEC } });
const profiles = await invoke("mongo_profiles");
const prof = profiles.find((p) => p.name === "E2E fixture");
check("the profile is saved: P1, read-only, Local, loopback, with no credentials anywhere in the view (the masked string has none)", !!prof && prof.aiMode === "schemaOnly" && prof.readOnly === true && prof.effectiveLevel === "local" && !/mongodb(\+srv)?:\/\/[^"\/]*@/.test(JSON.stringify(profiles)), JSON.stringify(prof).slice(0, 300));
const CONN = prof.id;
await snap("mongo-settings-database");
await press("Escape");
await waitFor(() => !dlg(), { what: "Settings to close", timeout: 5000 }).catch(() => undefined);

// ---- 4. browse the seeded collection ---------------------------------------------------------------------------------------------------------
step("browse");
await openRail("Database");
const tree = await waitFor(() => q('[role="tree"][aria-label="Databases and collections"]'), { what: "the databases tree" });
const connRow = await waitTreeItem("E2E fixture", tree);
pick(connRow);
// a profile that was never used and runs without TLS asks once which addresses it will contact (default button: Cancel)
const confirmFirstConnect = async () => {
  const d = await waitFor(() => qa('[role="alertdialog"]').find((a) => /for the first time/.test(text(a))), { what: "the first-connect question", timeout: 5000 }).catch(() => null);
  if (d) await clickButton("Connect", d);
};
await confirmFirstConnect();
// a click on the connection row connects; if the click landed before the tree was ready ("Press Enter to connect"), click again
let dbRow = await waitTreeItem(DBN, tree, 20000).catch(() => null);
if (!dbRow) { pick(treeItem("E2E fixture", tree) ?? connRow); await confirmFirstConnect(); dbRow = await waitTreeItem(DBN, tree, 60000); }
// a server with several databases (the real fixture holds a few): open the one under test
// (the panel opens the first user database by itself once connected: wait for its collections, and click only a row that is still closed, so a slow load is not toggled shut)
await waitFor(() => treeItem("orders", tree), { what: "the auto-opened database", timeout: 8000 }).catch(() => null);
if (!treeItem("orders", tree) && treeItem(DBN, tree)?.getAttribute("aria-expanded") !== "true") pick(treeItem(DBN, tree) ?? dbRow);
await waitFor(() => /\d/.test(text(treeItem("orders", tree) ?? "")), { what: "the estimated count of orders", timeout: 60000 });
const collRow = treeItem("orders", tree);
check("the tree lists the databases and the seeded collections with an estimated count", !!treeItem("customers", tree) && /\d/.test(text(collRow)), text(collRow));
await snap("mongo-tree");
pick(await waitTreeItem("orders", tree)); // look the row up again: the tree re-renders when the counts arrive
await waitFor(tabEl, { what: "the orders tab" });
await waitFor(() => gridRows() > 0 || q(".ui-empty", tabEl()), { what: "the first documents", timeout: 60000 });
if (gridRows() === 0) { await clickButton("Find", tabEl()); await waitFor(() => gridRows() > 0, { what: "documents after Find", timeout: 60000 }); }
const firstRange = rangeText();
const firstRow = () => text(qa('.ui-grid__row[role="row"]', tabEl())[0]);
const firstRowText = firstRow();
check("orders opens with a first page of documents (50 of the 50 000)", gridRows() >= 10 && /50/.test(firstRange), `${gridRows()} rows, "${firstRange}"`);
await snap("mongo-collection");

// ---- 5. ask in Hungarian: payload first, a draft that does not run by itself -------------------------------------------------------------------
step("ask 1");
const ask = async (question) => {
  await typeInto(askInput(), question);
  await press("Enter", {}, askInput());
};
await ask("a legutóbbi 10 rendelés");
const pdlg = await waitDialog(/Review what is sent/, "the first-send payload dialog", 60000);
await waitFor(() => text(q('pre[aria-label="The exact payload"]', pdlg)).length > 50, { what: "the payload text", timeout: 60000 });
const payloadText = text(q('pre[aria-label="The exact payload"]', pdlg));
check("What is sent: the exact payload is shown before the first send and holds no connection string, no document value", payloadText.length > 200 && !payloadText.includes("mongodb://") && !payloadText.includes("127.0.0.1") && payloadText.includes("orders"), `${payloadText.length} chars`);
notes.payloadBytes = payloadText.length;
await snap("mongo-payload");
await clickButton("Send this", pdlg);
await dialogGone(pdlg);
await waitFor(() => q("section.mg-review", tabEl()) || q(".mg-ai__note", tabEl()), { what: "the AI answer (a real Haiku call)", timeout: 180000 });
const strip = q("section.mg-review", tabEl());
check("the question became a reviewed draft", !!strip, text(q(".mg-ai__note", tabEl())));
if (!strip) throw new Error("no draft for the first question: " + text(q(".mg-ai__note", tabEl())));
check("the strip says nothing has run yet and shows an explanation and the valid-read badge", /Nothing has run yet/.test(text(strip)) && text(q(".mg-review__why", strip)).length > 10 && /Valid read query/.test(text(strip)), text(strip).slice(0, 300));
check("the draft did NOT run by itself: the same 50 rows are still shown", /1–50/.test(rangeText()) && firstRow() === firstRowText, `${gridRows()} rows; "${firstRange}" -> "${rangeText()}"`);
notes.draft1 = text(strip).slice(0, 400);
await snap("mongo-review");
await clickButton("Run generated query", strip);
await waitFor(() => !q("section.mg-review", tabEl()) && /1–10\b/.test(rangeText()) && firstRow() !== firstRowText, { what: "the 10 rows of the generated query", timeout: 60000 });
check("Run: exactly the 10 newest orders came back", /1–10\b/.test(rangeText()), `${gridRows()} rows, "${rangeText()}"`);
await snap("mongo-results");

// ---- 6. a restaurant by name (the model only knows ids), and a write intent ------------------------------------------------------------------
step("ask 2");
await ask("a legutóbbi 10 rendelés a Pizza Palotából");
await waitFor(() => q("section.mg-review", tabEl()) || q(".mg-ai__note", tabEl()), { what: "the second AI answer", timeout: 180000 });
const second = q("section.mg-review", tabEl()) ? "draft" : /more detail/i.test(text(q(".mg-ai__note", tabEl()))) ? "clarification" : "failed";
notes.pizzaOutcome = `${second}: ${text(q("section.mg-review, .mg-ai__note", tabEl())).slice(0, 300)}`;
check("... and the result list did not change on its own", /1–10\b/.test(rangeText()), rangeText());
await snap("mongo-ask-pizza");
if (q("section.mg-review", tabEl())) await clickButton("Discard", q("section.mg-review", tabEl()));

step("write intent");
const countBefore = await invoke("mongo_run", { req: { tab: "xcnt", connection: CONN, command: { cmd: "count", db: DBN, collection: "orders", filter: "{}" } } });
await ask("töröld az összes lemondott rendelést");
await waitFor(() => q("section.mg-review", tabEl()) || q(".mg-ai__note", tabEl()), { what: "the write-intent answer", timeout: 180000 });
const wi = q("section.mg-review", tabEl());
const wiText = text(wi ?? q(".mg-ai__note", tabEl()));
notes.writeIntent = wiText.slice(0, 400);
check("a delete request becomes a READ query for review (or is refused): the strip only offers Run generated query / Edit / Discard", !wi || (/Valid read query/.test(wiText) && !/(delete|drop|remove)Many/i.test(wiText) && qa("button", wi).map(text).every((t) => /^(Run generated query|Edit|Discard|Confirm: run a full scan)?$/.test(t))), wiText);
if (wi) await clickButton("Discard", wi);

// ---- 7. every write is refused ---------------------------------------------------------------------------------------------------------------
step("refuse writes");
const run = (command) => invoke("mongo_run", { req: { tab: "xw", connection: CONN, command } });
const e1 = await rejected(run({ cmd: "insertOne", db: DBN, collection: "orders", document: "{}" }));
check("a write command does not exist: insertOne is rejected by the closed command set", !!e1, errText(e1).slice(0, 160));
const e2 = await rejected(run({ cmd: "find", db: DBN, collection: "orders", filter: "{}", $out: "e2e_out" }));
check("an extra field on a find is rejected (deny_unknown_fields)", !!e2, errText(e2).slice(0, 160));
const e3 = await rejected(run({ cmd: "aggregate", db: DBN, collection: "orders", pipeline: '[{$match: {}}, {$out: "e2e_out"}]' }));
check("$out is refused", errCode(e3) === "mongoRejected", errText(e3).slice(0, 160));
const e4 = await rejected(run({ cmd: "aggregate", db: DBN, collection: "orders", pipeline: '[{$match: {}}, {$merge: {into: "e2e_out"}}]' }));
check("$merge is refused", errCode(e4) === "mongoRejected", errText(e4).slice(0, 160));
const e5 = await rejected(run({ cmd: "find", db: DBN, collection: "orders", filter: '{$where: "sleep(100)"}' }));
check("$where is refused", !!e5, errText(e5).slice(0, 160));
const e6 = await rejected(invoke("mongo_ai_generate", { req: { tab: "xw", connection: CONN, db: DBN, collection: "orders", question: "   " } }));
check("an empty question is refused before any model call", errCode(e6) === "mongoInvalid", errText(e6));
const countAfter = await invoke("mongo_run", { req: { tab: "xcnt", connection: CONN, command: { cmd: "count", db: DBN, collection: "orders", filter: "{}" } } });
const colls = await invoke("mongo_run", { req: { tab: "xcol", connection: CONN, command: { cmd: "listCollections", db: DBN } } });
check("nothing changed: the same document count and no e2e_out collection", JSON.stringify(countBefore.docs) === JSON.stringify(countAfter.docs) && !colls.docs.join("").includes("e2e_out"), `${countBefore.docs} / ${countAfter.docs}`);

// ---- 8. a non-loopback host is Production-level and never contacted --------------------------------------------------------------------------
step("production level");
const dummy = await invoke("mongo_profile_save", { input: { name: "Prod dummy", environment: "local", uri: "mongodb://prod-db.never-contacted.invalid:27017/happy", confirm: "Prod dummy" } });
check("a non-loopback host is Production-level whatever the tag says", dummy.effectiveLevel === "productionLevel" && dummy.environment === "local" && dummy.hostLevel === "productionLevel", JSON.stringify(dummy));
const dconn = await rejected(invoke("mongo_connect", { id: dummy.id }));
check("the jail refuses the connection before any socket (testJail)", errCode(dconn) === "testJail", errText(dconn));
findButton("Reload connections")?.click();
await waitFor(() => treeItem("Prod dummy", q('[role="tree"][aria-label="Databases and collections"]')), { what: "the dummy connection in the tree", timeout: 15000 });
const prodRow = treeItem("Prod dummy", q('[role="tree"][aria-label="Databases and collections"]'));
check("the tree marks it as production (danger edge and a Production pill, not the Local tag)", prodRow.hasAttribute("data-danger") && /production/i.test(text(prodRow)), prodRow.outerHTML.slice(0, 200));
await snap("mongo-production");
const lowered = await rejected(invoke("mongo_profile_save", { input: { name: "Prod dummy", id: dummy.id, environment: "local", aiMode: "schemaOnly" } }));
check("turning AI on for it without the typed name is refused", errCode(lowered) === "mongoConfirm", errText(lowered));

// ---- 9. switch the module off ------------------------------------------------------------------------------------------------------------------
step("switch off");
await openSettings("Database");
await waitFor(sw, { what: "the switch again" });
sw().click();
await waitFor(() => sw().getAttribute("aria-checked") === "false", { what: "the switch to turn off" });
await waitFor(() => !railButton("Database"), { what: "the rail item to disappear", timeout: 15000 });
st = await status();
check("off again: the rail item is gone, no connection or session is left", st.enabled === false && st.connections.length === 0 && !q("section.mg-tab"));
const after = await rejected(invoke("mongo_run", { req: { tab: "xw", connection: CONN, command: { cmd: "listDatabases" } } }));
check("off again: a run is refused with mongoDisabled", errCode(after) === "mongoDisabled", errText(after));
await snap("mongo-off");
await press("Escape");
await finish();
