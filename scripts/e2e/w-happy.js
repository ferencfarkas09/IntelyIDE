// (w) Happy Time Tracer + Meet against scripts/mock-happy (loopback, never the real service), then the failure banners: 403 on one
// provider (Meet: "Not permitted") and 401 (the session was revoked: the persistent "session expired" notice in the status bar, until
// a token is saved again). The page may not reach the mock (CSP), so control calls go through run.sh: a .mock-cmd file in a fixture repo.
await waitForTree();
const BE = FX.repoIds[0];
const chip = () => q('button[aria-label^="Time tracker"]');
const dlgOf = () => q(".settings");
const pane = () => q(".settings__pane", dlgOf());
const sw = (label) => q(`[role="switch"][aria-label="${label}"]`, pane());
let ackN = 0;
/** Asks run.sh to POST /__mock/<name> with a JSON body and waits for its acknowledgement. */
async function mockCtl(name, body = {}) {
  const line = `${name}|${JSON.stringify({ ...body, n: ackN++ })}`;
  await invoke("files_write_file", { repoId: BE, relPath: ".mock-cmd", text: `${line}\n`, expectedMtimeMs: 0, reveal: false });
  await waitFor(async () => (await invoke("files_read_file", { repoId: BE, relPath: ".mock-ack" }).catch(() => null))?.text?.trim() === line, { what: `the mock control "${name}"`, timeout: 15000, interval: 200 });
}
async function openIntegrations() {
  if (!dlgOf()) { await press(",", { meta: true }); await waitFor(dlgOf, { what: "Settings" }); }
  (await waitFor(() => qa(".settings__item", dlgOf()).find((b) => text(b) === "Integrations"), { what: "the Integrations section" })).click();
  await waitFor(() => sw("Happy integrations"), { what: "the master switch", timeout: 15000 });
}
const turnOn = async (label) => {
  await waitFor(() => sw(label) && !sw(label).disabled, { what: `${label} to be usable` });
  if (sw(label).getAttribute("aria-checked") !== "true") sw(label).click();
  await waitFor(() => sw(label).getAttribute("aria-checked") === "true", { what: `${label} on`, timeout: 15000 });
};
const closeSettings = async () => { await press("Escape"); await waitFor(() => !dlgOf(), { what: "Settings to close", timeout: 5000 }); };

// ---- configure, like a user ----------------------------------------------------------------------------------------------------------------------
step("configure");
await openIntegrations();
await turnOn("Happy integrations");
await turnOn("Time Tracer on or off");
await turnOn("Meet on or off");
(await waitFor(() => qa('[role="radiogroup"][aria-label="Environment"] [role="radio"]', pane()).find((r) => text(r) === "Custom"), { what: "the Custom environment option" })).click();
const url = await waitFor(() => q("#happy-base-url", pane()), { what: "the base URL field" });
await typeInto(url, `http://127.0.0.1:${HAPPY.port}`);
await press("Enter", {}, url);
await sleep(300);
await typeInto(await waitFor(() => q("#happy-token", pane()), { what: "the token field" }), HAPPY.token);
await clickButton("Save token", pane());
await waitFor(() => /A token is saved/.test(text(pane())), { what: "the token to be saved", timeout: 20000 });
await clickButton("Test connection", pane());
await waitFor(() => /Teszt Elek|Connected|Ready/i.test(text(pane())), { what: "the connection test", timeout: 20000 });
check("Test connection reaches the mock; the token is not shown", !text(pane()).includes(HAPPY.token) && !qa("input", pane()).some((i) => i.value === HAPPY.token));
await closeSettings();
await waitFor(chip, { what: "the timer chip", timeout: 30000 });

// ---- Tracer: start and stop a task -----------------------------------------------------------------------------------------------------------
step("tracer");
chip().click();
const list = await waitFor(() => q('[role="listbox"][aria-label="Tasks"]'), { what: "the task picker" });
await waitFor(() => qa('[role="option"]', list).length >= 3, { what: "tasks from the mock", timeout: 20000 });
qa('[role="option"]', list).find((o) => /Receipts/.test(text(o))).click();
await waitFor(() => /Receipts/.test(chip().getAttribute("aria-label")), { what: "the chip to name the task", timeout: 20000 });
check("Tracer: starting a task names it on the chip", true, chip().getAttribute("aria-label"));
await clickButton("Stop", q(".ht-pop"));
await waitFor(() => /not tracking/.test(chip().getAttribute("aria-label")), { what: "the chip to go idle", timeout: 20000 });
check("Tracer: Stop ends it", true);

// ---- Meet: the list, Join (the harness records the host instead of opening a browser) ---------------------------------------------------------
step("meet");
const label = await waitFor(() => q(".happy-meet__label"), { what: "the live/upcoming meeting in the status bar", timeout: 30000 });
check("Meet: the status bar names a meeting", text(label).length > 3, text(label));
label.click();
const mt = await waitFor(() => q(".mt"), { what: "the Meet tab", timeout: 20000 });
await waitFor(() => qa(".mt__row", mt).length >= 1, { what: "meetings in the tab", timeout: 20000 });
check("Meet: the tab lists meetings with a Join button each", qa(".mt__row", mt).every((r) => !!findButton("Join", r)), qa(".mt__row", mt).map(text).join(" | "));
await snap("happy-meet");
findButton("Join", qa(".mt__row", mt)[0]).click();
await sleep(1500);
check("Meet: Join raised no error toast", !toastList().some((t) => t.tone === "danger"), toastText());

// ---- 403 on Meet: the provider is not permitted ---------------------------------------------------------------------------------------------
step("403");
await mockCtl("fail", { status: 403, path: "/api/chat/meetings", count: 1000 });
findButton("Refresh", mt)?.click();
await waitFor(() => !q(".mt") || /Out of date|could not load|not permitted|off/i.test(text(q(".mt") ?? document.body)) || toastList().length, { what: "the 403 to show", timeout: 20000 }).catch(() => undefined);
await openIntegrations();
notes.events = [];
await invoke("plugin:event|listen", { event: "happy:state", target: { kind: "Any" }, handler: window.__TAURI_INTERNALS__.transformCallback((e) => notes.events.push(e.payload.providers.map((p) => p.id + ":" + p.state).join(",")), false) });
// switching Meet off and on starts its polling again, which meets the 403 straight away
sw("Meet on or off").click();
await waitFor(() => sw("Meet on or off").getAttribute("aria-checked") === "false", { what: "Meet off", timeout: 10000 });
await turnOn("Meet on or off");
await sleep(6000);
notes.status403 = JSON.stringify(await invoke("happy_status")).slice(0, 1500);
notes.meetList403 = JSON.stringify(await invoke("happy_meet_list").catch((e) => ({ err: e }))).slice(0, 300);
const meetLine = () => (text(pane()).match(/See live and upcoming meetings[^]*?(Connecting|Connected|Not permitted|Off|Signed out|Degraded|Error)/) ?? [])[1];
notes.meetBefore = meetLine();
const pushed = await waitFor(() => /Not permitted/.test(text(pane())), { what: "the pushed Not permitted state", timeout: 25000 }).then(() => true, () => false);
check("403: the open Integrations pane follows the state change by itself (pushed event)", pushed, `Meet shows "${meetLine()}" while the backend says notPermitted`);
if (!pushed) { await closeSettings(); await openIntegrations(); }
await waitFor(() => /Not permitted/.test(text(pane())), { what: "the 'Not permitted' state of Meet in Integrations", timeout: 15000 });
check("403: Integrations shows Meet as Not permitted (Time Tracer unaffected)", /Not permitted/.test(text(pane())), text(pane()).slice(0, 400));
notes.pane403 = text(pane()).slice(0, 500);
await snap("happy-403");
await closeSettings();

// ---- 401: the session was revoked -------------------------------------------------------------------------------------------------------------
step("401");
await mockCtl("reset");
await mockCtl("revoke");
await openIntegrations();
await clickButton("Test connection", pane());
await waitFor(() => q(".happy-signedout"), { what: "the signed-out notice in the status bar", timeout: 40000 });
check("401: the status bar shows the persistent 'session expired' notice", /expired|revoked|signed|sign/i.test(text(q(".happy-signedout")) + (q(".happy-signedout").title ?? "")), text(q(".happy-signedout")) + " / " + q(".happy-signedout").title);
check("401: Integrations says the session expired or was revoked", /expired or was revoked|Signed out/i.test(text(pane())), text(pane()).slice(0, 300));
await snap("happy-401");
// a fresh token clears it
await mockCtl("reset");
await typeInto(await waitFor(() => q("#happy-token", pane()), { what: "the token field again" }), HAPPY.token);
await clickButton("Save token", pane());
await waitFor(() => !q(".happy-signedout"), { what: "the notice to clear after a new token", timeout: 40000 });
check("401: saving the token again clears the notice", true);
await closeSettings();
await finish();
