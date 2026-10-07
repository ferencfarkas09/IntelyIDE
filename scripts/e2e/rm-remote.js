// (rm) IntelyIDE Remote end to end on the real window: Settings > Remote, pairing with the SAS against the real phone PWA (headless Chrome
// driven by remote-web/test/e2e/desktop.e2e.test.ts over a local wrangler relay), a MOCK-provider run watched and answered from the phone,
// first-answer-wins both ways, the remote safety probes, revoke, kill switch and panic. The phone half talks to this script through
// .rm-cmd / .rm-ack files in the backend fixture repo (the page may not reach loopback). Needs INTELY_MOCK_PROVIDER=1 and the settings
// seeded by run.sh (relay URL, Mac name, expected build hash).
await waitForTree();
setTimeout(() => { if (!window.__e2eFinished) void failWith(new Error("watchdog: stuck at " + notes.step)); }, 330000);
const ws = await invoke("workspace_get");
const nameOf = (id) => ws.repos.find((r) => r.id === id).name;
const [BACKEND, ADMIN, SERVICES, POS] = FX.repoIds.map(nameOf);
const BE = FX.repoIds[0];

let rmN = 0;
/** One request to the phone driver; resolves with its acknowledgement object. */
async function rm(name, arg = {}, timeout = 90000) {
  const line = `${name}|${JSON.stringify({ ...arg, n: rmN++ })}`;
  await invoke("files_write_file", { repoId: BE, relPath: ".rm-cmd", text: `${line}\n`, expectedMtimeMs: 0, reveal: false });
  let got = null;
  await waitFor(async () => {
    const r = await invoke("files_read_file", { repoId: BE, relPath: ".rm-ack" }).catch(() => null);
    try { const j = JSON.parse(r?.text ?? ""); if (j.line === line) { got = j; return true; } } catch { /* partial write */ }
    return false;
  }, { what: `the phone driver to answer ${name}`, timeout, interval: 150 });
  if (got.error) throw new Error(`phone driver ${name}: ${got.error}`);
  return got;
}
async function shot(name) {
  try { (notes.shots ??= []).push(await window.__e2e.screenshot(name)); } catch (e) { (notes.shotErrors ??= []).push(String(e?.message ?? e)); }
}
const dlg = () => q(".settings");
const pane = () => q(".settings__pane", dlg());
const sw = () => q('[role="switch"][aria-label="Enable Remote"]', pane());
async function openRemote() {
  if (!dlg()) { await press(",", { meta: true }); await waitFor(dlg, { what: "Settings" }); }
  (await waitFor(() => qa(".settings__item", dlg()).find((b) => text(b) === "Remote"), { what: "the Remote section in Settings" })).click();
  await waitFor(() => sw(), { what: "the Enable Remote switch", timeout: 15000 });
}
const isOn = () => sw()?.getAttribute("aria-checked") === "true";
const closeSettings = async () => { if (dlg()) { await press("Escape"); await waitFor(() => !dlg(), { what: "Settings to close", timeout: 5000 }); } };
const chip = () => q('button.remote-chip');
const lastReqId = async (agentId, kind) => {
  const h = await historyOf(agentId);
  return [...h.events].reverse().find((e) => e.kind === kind)?.reqId;
};
const agentOf = async (role) => (await invoke("agent_list")).find((a) => a.role === role);

const hello = await rm("hello");
const manifestHash = hello.bundle;

// ---- 1. off: nothing runs, nothing is open ---------------------------------------------------------------------------------
step("1. off: nothing runs, nothing is open");
check("1 off: no Remote chip in the status bar", !chip());
await openRemote();
check("1 off: the switch defaults to off", !isOn(), sw()?.getAttribute("aria-checked"));
check("1 off: the pairing button is disabled", q('[data-testid="pair"]', pane())?.disabled === true);
await waitFor(() => text(pane()).includes(manifestHash), { what: "the expected build hash on the Mac", timeout: 10000 }).catch(() => {});
check("1 off: the Mac shows the expected build hash from the signed bundle", text(pane()).includes(manifestHash), manifestHash);
await shot("remote-off");
const off = await rm("sample", { label: "off" });
check("1 off: no socket to the relay and the relay saw no WebSocket upgrade", off.relaySockets === 0 && off.relayLog === 0, JSON.stringify(off));

// ---- 2. on -----------------------------------------------------------------------------------------------------------------
step("2. on");
sw().click();
await waitFor(isOn, { what: "Remote switched on", timeout: 20000 });
await waitFor(() => chip(), { what: "the status-bar chip", timeout: 10000 });
await waitFor(async () => (await rm("sample", { label: "on" })).relaySockets >= 1, { what: "the gateway socket to the relay", timeout: 20000, interval: 500 });
const on = await rm("sample", { label: "on" });
check("2 on: one relay socket, the chip is in the status bar", on.relaySockets >= 1 && !!chip(), JSON.stringify(on));
await shot("remote-on");

// ---- 3. pair with the SAS --------------------------------------------------------------------------------------------------
step("3. pair with the SAS");
q('[data-testid="pair"]', pane()).click();
const link = await waitFor(() => q(".remote-pair__qr[data-link]")?.getAttribute("data-link"), { what: "the pairing offer", timeout: 20000 });
check("3 the dialog shows the QR, a manual code and the build hash", !!q('svg[aria-label="Pairing QR code"]') && /\S{5}-\S{5}/.test(text(q('[data-testid="manual-code"]'))) && text(q('[data-testid="expected-hash"]')) === manifestHash, text(q('[data-testid="manual-code"]')));
await shot("pair-qr");
const pairRes = await rm("pair", { link });
check("3 the phone shows the same build hash as the Mac expects", pairRes.phoneHash === manifestHash, `${pairRes.phoneHash} vs ${manifestHash}`);
const sasEl = await waitFor(() => q('[data-testid="sas"]'), { what: "the SAS on the Mac", timeout: 30000 });
check("3 the six digits on the Mac equal the phone's", text(sasEl).replace(/\s/g, "") === pairRes.sas, `${text(sasEl)} vs ${pairRes.sas}`);
await shot("pair-sas");
const nameInput = q('input[aria-label="Device name"]');
await typeInto(nameInput, "E2E iPhone");
(await waitFor(() => qa('[role="radio"]', q('[aria-label="What this phone may do"]')).find((b) => text(b) === "Can reply"), { what: "Can reply" })).click();
await clickButton("Codes match: approve");
await rm("paired");
await waitFor(() => q('[data-testid="device-row"]'), { what: "the device row", timeout: 15000 });
check("3 the devices list shows the phone with its level", /E2E iPhone/.test(text(q('[data-testid="device-row"]'))) && /Reply/.test(text(q('[data-testid="device-row"]'))), text(q('[data-testid="device-row"]')));
await shot("devices");

// ---- 4. a run watched and answered from the phone --------------------------------------------------------------------------
step("4. a run watched and answered from the phone");
await closeSettings();
await openAgents();
const roles = await invoke("agent_roles");
const askRole = roles.find((r) => /ask/.test(r.name))?.name ?? "mock-ask-question";
await newRun(askRole, [BACKEND], "ask me");
const qcard = await waitFor(() => q('section[aria-label="Question from the agent"], [aria-label="Question from the agent"]'), { what: "the question on the Mac", timeout: 30000 });
const pq = await rm("card", { kind: "question", shot: "04-question" });
check("4 the phone shows the question", /colour/i.test(pq.text), pq.text);
await rm("phone-answer", { how: "choose", option: "Blue" });
await waitFor(() => /Thanks, noted/.test(panelText()), { what: "the run to continue after the phone's answer", timeout: 30000 });
await waitFor(() => runStatusText() === "Done", { what: "Done after the phone's answer" });
const hq = await historyOf((await agentOf(askRole)).agentId);
check("4 the phone's answer reached the run (the log carries a question answer, gap-free)", hq.problems.length === 0 && JSON.stringify(hq.events).includes("Blue"), hq.problems.join(";"));
const lateQ = await invoke("agent_answer_question", { agentId: (await agentOf(askRole)).agentId, requestId: "q-t1", answer: { optionIds: ["Red"], text: null } }).then(() => "accepted", (e) => e.code);
check("4 a late answer from the Mac to the question the phone already answered is refused", lateQ !== "accepted", lateQ);

// ---- 7. a hard stop never asks and nothing on the phone can approve it ----------------------------------------------------
step("7. a hard stop never asks and nothing on the phone can approve it");
await newRun("mock-hard-stop", [SERVICES], "push it");
await waitFor(() => /Blocked by a hard stop/.test(panelText()), { what: "the hard stop line", timeout: 30000 });
await waitFor(() => runStatusText() === "Done", { what: "Done after the hard stop" });
const hardRun = await agentOf("mock-hard-stop");
const hs = await rm("phone-sees", { text: ".", timeout: 3000, shot: "07-after-hard-stop" });
check("7 the hard stop raised no card on the phone", hs.cards === 0, JSON.stringify(hs));
const runView = await rm("phone-run", { shot: "07-run", back: true });
check("7 the phone's transcript of the run is readable (no card, content shown)", runView.text.length > 20, runView.text);


// ---- 5. a Write outside the repo is Mac-only; the attacks; the Mac's answer is final -----------------------------------
step("5. permission, attacks");
await newRun("mock-tool-permission", [BACKEND], "write a note");
const cardA = await waitFor(permissionCard, { what: "the permission card on the Mac", timeout: 30000 });
const pa = await rm("card", { kind: "permission", shot: "05-permission" });
check("5 the phone shows the request but offers no way to allow it (Mac only), and no one-tap", /notes\.txt|Write/i.test(pa.text) && pa.desktopOnly && !pa.allowOnce && !pa.stepUp, JSON.stringify(pa));
const runP = (await invoke("agent_list")).find((a) => a.status !== "done" && a.status !== "error" && a.role === "mock-tool-permission");
step("8. remote safety probes");
await rm("hash-state");
const probe = await rm("probe", { hardRunId: hardRun.agentId }, 120000);
check("8 every attack was refused (approve without step-up, step-up request with no passkey path (forged-signature, wrong-challenge and replay are covered by the Rust test step_up_rejects_a_wrong_challenge_origin_rp_and_a_forged_signature), wrong hash, hard-stopped, git push template, state-dir template, unknown verb, level raise)", probe.probes.length >= 8 && probe.probes.every((p) => p.refused), JSON.stringify(probe.probes.map((p) => `${p.name}: ${p.code ?? p.message}`)));
check("8 the Remote state (devices and levels) is unchanged after the attack", probe.stateBefore === probe.stateAfter, `${probe.stateBefore} ${probe.stateAfter}`);
check("8 the request is still pending on the Mac, nothing was approved", !!permissionCard() && !/notes\.txt written/.test(panelText()), panelText().slice(0, 300));
await rm("phone-live");
findButton("Allow once", permissionCard()).click();
await waitFor(() => /Done: notes\.txt written/.test(panelText()), { what: "the run after the Mac's Allow once", timeout: 30000 });
const sawA = await rm("phone-sees", { text: "on the Mac", shot: "05-answered-on-mac" });
check("5 the phone's card locks as answered on the Mac (first answer wins)", sawA.ok, JSON.stringify(sawA));
const hp = await historyOf(runP.agentId);
check("5 the log shows exactly one decision, made on the Mac", hp.problems.length === 0 && hp.events.filter((e) => e.kind === "permission.resolved").length === 1, JSON.stringify(hp.events.filter((e) => /permission/.test(e.kind)).map((e) => e.kind + ":" + (e.by ?? e.origin ?? ""))));
await shot("agents-after-permission");

// ---- 9. audit --------------------------------------------------------------------------------------------------------------
step("9. audit");
await openRemote();
(await waitFor(() => q('[data-testid="audit-toggle"]', pane()), { what: "the audit toggle (the section loads its view first)", timeout: 20000 })).click();
await waitFor(() => q('[data-testid="audit"]'), { what: "the audit list", timeout: 10000 });
const auditText = text(q('[data-testid="audit"]'));
check("9 the audit viewer lists the pairing, the answers and the rejected attempts", /pair/i.test(auditText) && /answer/i.test(auditText) && /(reject|denied|refus)/i.test(auditText), auditText.slice(0, 400));
await shot("audit");

// ---- 10. revoke: the phone drops ------------------------------------------------------------------------------------------
step("10. revoke: the phone drops");
await rm("phone-live");
await closeSettings();
await openRemote();
await clickButton("Revoke", q('[data-testid="device-row"]'));
await clickButton("Revoke now");
const dropped = await rm("phone-revoked", {}, 60000);
check("10 revoke: the phone drops to the revoked screen and wipes its keys", dropped.ok && dropped.storage.length === 0, JSON.stringify(dropped));
await waitFor(() => /No phone is paired/.test(text(pane())), { what: "an empty devices list", timeout: 10000 });
const rej = await rm("phone-rejected");
check("10 a reload does not bring the revoked phone back", !rej.stillPaired, JSON.stringify(rej));
await shot("revoked");

// ---- 11. the kill switch from the status bar, then panic -------------------------------------------------------------------
step("11. the kill switch from the status bar, then panic");
await closeSettings();
chip().click();
const killItem = await waitFor(() => qa('[role="menuitem"]').find((b) => /Kill switch/.test(text(b))), { what: "the kill switch in the chip menu", timeout: 5000 });
await shot("chip-menu");
killItem.click();
await waitFor(() => !chip(), { what: "the chip to disappear after the kill switch", timeout: 15000 });
let killed = await rm("sample", { label: "killed" });
await waitFor(async () => (killed = await rm("sample", { label: "killed" })).relaySockets === 0, { what: "the relay socket to close", timeout: 15000, interval: 500 });
// idle runtime threads (blocking pool, 10 s keep-alive) linger after the runs above; the zero-cost claim is that they drain back to the off level
await waitFor(async () => Math.abs((killed = await rm("sample", { label: "killed" })).threads - off.threads) <= 3, { what: "the thread count to settle", timeout: 40000, interval: 2500 }).catch(() => {});
check("11 kill switch: Remote is off, no relay socket remains", !chip() && killed.relaySockets === 0, JSON.stringify(killed));
await openRemote();
check("11 kill switch: the switch reads off", !isOn());
window.confirm = () => true; // the native confirm would block the harness; the question text is covered by unit tests
sw().click();
await waitFor(isOn, { what: "Remote on again", timeout: 20000 });
await clickButton("Panic: revoke everything");
await waitFor(() => !isOn(), { what: "Remote off after panic", timeout: 20000 });
check("11 panic: Remote is off", !isOn());
await shot("after-panic");
const end = await rm("bye");

const threadsOff = off.threads, threadsKilled = killed.threads;
check("12 zero cost: thread count back to the off level after the kill switch (+-3)", Math.abs(threadsKilled - threadsOff) <= 3, `off ${threadsOff}, on ${on.threads}, killed ${threadsKilled}`);
await finish({ threads: { off: threadsOff, on: on.threads, killed: threadsKilled } });
