// (zz) Happy realtime + inbox + tasks against scripts/mock-happy (loopback, never the real service): zero cost while everything is off,
// then Team chat (unread badge, a scripted message, send, 402 out of credits, a 401 on the socket), the Notifications badge and My tasks
// with "Start agent on task" (it only prefills New run). The page cannot reach the mock (CSP): control calls and probes go through run.sh
// (a .mock-cmd file in a fixture repo); run.sh judges what the mock saw (verify_zz).
await waitForTree();
const BE = FX.repoIds[0];
const dlgOf = () => q(".settings");
const pane = () => q(".settings__pane", dlgOf());
const sw = (label) => q(`[role="switch"][aria-label="${label}"]`, pane());
let ackN = 0;
async function mockCtl(name, body = {}) {
  const line = `${name}|${JSON.stringify({ ...body, n: ackN++ })}`;
  await invoke("files_write_file", { repoId: BE, relPath: ".mock-cmd", text: `${line}\n`, expectedMtimeMs: 0, reveal: false });
  await waitFor(async () => (await invoke("files_read_file", { repoId: BE, relPath: ".mock-ack" }).catch(() => null))?.text?.trim() === line, { what: `the mock control "${name}"`, timeout: 15000, interval: 200 });
}
const probe = (label) => mockCtl("probe", { label });
async function openIntegrations() {
  if (!dlgOf()) { await press(",", { meta: true }); await waitFor(dlgOf, { what: "Settings" }); }
  (await waitFor(() => qa(".settings__item", dlgOf()).find((b) => text(b) === "Integrations"), { what: "the Integrations section" })).click();
  await waitFor(() => sw("Happy integrations"), { what: "the master switch", timeout: 15000 });
}
const isOn = (el) => el?.getAttribute("aria-checked") === "true";
const setSwitch = async (label, want) => {
  await waitFor(() => sw(label) && !sw(label).disabled, { what: `${label} to be usable` });
  if (isOn(sw(label)) !== want) sw(label).click();
  await waitFor(() => isOn(sw(label)) === want, { what: `${label} ${want ? "on" : "off"}`, timeout: 15000 });
};
const closeSettings = async () => { await press("Escape"); await waitFor(() => !dlgOf(), { what: "Settings to close", timeout: 5000 }); };
// Mention toasts last 6 s and stay while the pointer rests on them; shots are taken seconds after the event, so clear them first.
const snapClean = async (name) => {
  qa('.ui-toast button[aria-label="Dismiss"]').forEach((b) => b.click());
  await sleep(400);
  await snap(name);
};
const bubble = () => q("button.hc-sb");
const inboxBtn = () => q("button.happy-inbox");
const chatPane = () => q('[data-testid="chat-tab"]');
// The mock's channel ids are 24-hex like the real backend's (scripts/mock-happy/helpers.mjs); control calls also accept the name ("general").
const GENERAL = "5f1000000000000000000001";

// ---- zero cost: a token and a URL are saved, but nothing is switched on ------------------------------------------------------------------------
step("zero-cost");
await openIntegrations();
check("every Happy provider starts off", ["Time Tracer", "Meet", "Team chat", "Notifications", "My tasks"].every((n) => sw(`${n} on or off`) && !isOn(sw(`${n} on or off`))), qa('[role="switch"]', pane()).map((s) => `${s.getAttribute("aria-label")}=${s.getAttribute("aria-checked")}`).join(" "));
await setSwitch("Happy integrations", true);
(await waitFor(() => qa('[role="radiogroup"][aria-label="Environment"] [role="radio"]', pane()).find((r) => text(r) === "Custom"), { what: "the Custom environment option" })).click();
const url = await waitFor(() => q("#happy-base-url", pane()), { what: "the base URL field" });
await typeInto(url, `http://127.0.0.1:${HAPPY.port}`);
await press("Enter", {}, url);
await sleep(300);
await typeInto(await waitFor(() => q("#happy-token", pane()), { what: "the token field" }), HAPPY.token);
await clickButton("Save token", pane());
await waitFor(() => /A token is saved/.test(text(pane())), { what: "the token to be saved", timeout: 20000 });
await probe("saved"); // Save token is an explicit user action: it checks the token once (user/me + one read per provider)
await sleep(6000); // master on + token + every provider off: no poller, no socket, no further request
await probe("off-master-on");
await setSwitch("Happy integrations", false);
await sleep(4000);
await probe("off-master-off");
check("zero cost: no status-bar bubble, inbox or tasks item while off", !bubble() && !inboxBtn(), "");
await snapClean("zz-all-off");

// ---- switch on Team chat, Notifications, My tasks -----------------------------------------------------------------------------------------------
step("enable");
await setSwitch("Happy integrations", true);
await setSwitch("Team chat on or off", true);
await setSwitch("Notifications on or off", true);
await setSwitch("My tasks on or off", true);
await closeSettings();

// ---- chat: unread badge, scripted message ------------------------------------------------------------------------------------------------------
step("chat");
await waitFor(bubble, { what: "the chat bubble in the status bar", timeout: 40000 });
await waitFor(() => /3 unread/.test(bubble().getAttribute("aria-label")), { what: "3 unread from the bootstrap", timeout: 40000 });
check("chat: the status bar bubble shows the unread total from the mock bootstrap", true, bubble().getAttribute("aria-label"));
await probe("chat-on");
await mockCtl("chat/say", { channelId: "general", text: "zz scripted hello from the mock", from: "u_2" });
await waitFor(() => /4 unread/.test(bubble().getAttribute("aria-label") ?? ""), { what: "the unread badge to grow to 4 after the scripted message", timeout: 30000 });
check("chat: a scripted socket message raises the unread badge to 4", true, bubble().getAttribute("aria-label"));
bubble().click();
await waitFor(chatPane, { what: "the Chat tab", timeout: 20000 });
await waitFor(() => q(`[role="option"][data-channel="${GENERAL}"]`, chatPane()), { what: "the general channel in the list", timeout: 20000 });
await snapClean("zz-chat-list");
q(`[role="option"][data-channel="${GENERAL}"]`, chatPane()).click();
await waitFor(() => /zz scripted hello from the mock/.test(text(chatPane())), { what: "the scripted message in the conversation", timeout: 30000 });
check("chat: the conversation shows the scripted message", true);
await waitFor(() => !/\b4 unread/.test(bubble()?.getAttribute("aria-label") ?? ""), { what: "unread to drop after reading general", timeout: 30000 });
check("chat: reading the conversation lowers the unread badge", true, bubble()?.getAttribute("aria-label"));

// ---- send, then 402 -----------------------------------------------------------------------------------------------------------------------------
step("send");
const box = () => q(".hc-composer textarea", chatPane());
const sendText = async (t) => { await typeInto(box(), t); await press("Enter", {}, box()); };
check("chat: the composer states the credit cost", /credit/.test(text(q(".hc-composer__meta", chatPane()))), text(q(".hc-composer__meta", chatPane())));
await sendText("zz hello from the IDE");
await waitFor(() => /zz hello from the IDE/.test(text(q(".hc-conv__body", chatPane()) ?? chatPane())), { what: "the sent message in the list", timeout: 20000 });
await sleep(1500);
check("chat: the sent message was accepted (no Retry button)", !findButton("Retry", chatPane()), text(chatPane()).slice(-200));
await probe("sent");
await snapClean("zz-chat-sent");
step("402");
await mockCtl("chat/credits", { credits: 0 });
await sendText("zz this one is refused");
await waitFor(() => /Out of credits/.test(text(chatPane())), { what: "the Out of credits banner", timeout: 20000 });
check("402: the out-of-credits banner shows and the failed message offers Retry", !!findButton("Retry", chatPane()) && !!findButton("Check again", chatPane()), text(chatPane()).slice(-300));
check("402: the draft text is kept on the failed message", /zz this one is refused/.test(text(chatPane())));
await snapClean("zz-chat-402");
await mockCtl("chat/credits", { credits: 5 });
await clickButton("Check again", chatPane());
await waitFor(() => !/Out of credits/.test(text(chatPane())), { what: "the banner to clear after Check again", timeout: 20000 });
findButton("Retry", chatPane())?.click();
await waitFor(() => !findButton("Retry", chatPane()), { what: "the retried message to go through", timeout: 20000 });
check("402: after Check again, Retry sends the same message", true);

// ---- notifications + tasks (before the sign-out) ------------------------------------------------------------------------------------------------
step("inbox");
await waitFor(inboxBtn, { what: "the notifications bubble", timeout: 60000 });
await waitFor(() => /2/.test(inboxBtn().getAttribute("aria-label") ?? ""), { what: "2 unread notifications", timeout: 40000 });
check("inbox: the status bar badge counts the unread notifications", true, inboxBtn().getAttribute("aria-label"));
inboxBtn().click();
await waitFor(() => q(".ib"), { what: "the Notifications tab", timeout: 20000 });
await waitFor(() => qa(".ib__row").length >= 2, { what: "notifications in the tab", timeout: 20000 });
await snapClean("zz-inbox");
q('button[aria-label^="Mark"]', q(".ib")).click();
await waitFor(() => /1/.test(inboxBtn().getAttribute("aria-label") ?? "") && !/2/.test(inboxBtn().getAttribute("aria-label") ?? ""), { what: "the badge to drop to 1", timeout: 20000 });
check("inbox: Mark as read lowers the badge", true, inboxBtn().getAttribute("aria-label"));

step("tasks");
await runCommand("Tasks: Show my tasks");
await waitFor(() => q(".tk"), { what: "the Tasks tab", timeout: 20000 });
await waitFor(() => qa(".tk__row").length >= 3, { what: "tasks from the mock", timeout: 60000 });
const rows = qa(".tk__row").map(text).join(" | ");
check("tasks: lists my tasks and hides other people's", /Receipts/.test(rows) && !/Somebody else/.test(rows), rows.slice(0, 300));
await snapClean("zz-tasks");
const agentBtn = await waitFor(() => q('button[aria-label^="Start an agent on Receipts"]'), { what: "Start agent on the Receipts task" });
agentBtn.click();
const nr = await waitFor(() => qa('[role="dialog"]').find((d) => /New agent run/.test(text(d))), { what: "the New agent run dialog", timeout: 20000 });
const prompt = await waitFor(() => q('textarea[aria-label="Prompt"]', nr), { what: "the Prompt field" });
await waitFor(() => /HP-142/.test(prompt.value), { what: "the prompt to be prefilled", timeout: 10000 });
check("tasks: Start agent on task opens New run with the task in the prompt", /HP-142/.test(prompt.value) && /Receipts/.test(prompt.value), prompt.value.slice(0, 200));
prompt.scrollIntoView({ block: "center" });
await sleep(300);
await snapClean("zz-tasks-newrun");
await press("Escape");
await waitFor(() => !nr.isConnected, { what: "New run to close", timeout: 5000 }).catch(() => undefined);

// ---- 401 on the socket: everything stops, no retry storm -----------------------------------------------------------------------------------------
step("401");
bubble().click();
await waitFor(chatPane, { what: "the Chat tab again", timeout: 20000 });
await mockCtl("chat/reject", { mode: "unauthorized" });
await mockCtl("chat/drop");
await waitFor(() => q(".happy-signedout"), { what: "the signed-out notice in the status bar", timeout: 60000 });
check("401: the status bar shows the persistent session-expired notice", true, text(q(".happy-signedout")));
await sleep(1500);
await probe("after401-a");
await sleep(8000);
await probe("after401-b");
await waitFor(() => /Your Happy session ended/.test(text(document.body)), { what: "the chat gate to say the session ended", timeout: 15000 }).catch(() => undefined);
await snapClean("zz-401");
check("401: the Chat tab says the session ended", /Your Happy session ended/.test(text(document.body)), text(q(".hc") ?? document.body).slice(0, 200));
await mockCtl("chat/reject", { mode: null });
await mockCtl("reset");
await openIntegrations();
await typeInto(await waitFor(() => q("#happy-token", pane()), { what: "the token field again" }), HAPPY.token);
await clickButton("Save token", pane());
await waitFor(() => !q(".happy-signedout"), { what: "the notice to clear after a new token", timeout: 40000 });
check("401: saving the token again clears the notice", true);

// ---- all off again: the socket closes and the requests stop -------------------------------------------------------------------------------------
step("all-off");
for (const n of ["Team chat", "Notifications", "My tasks"]) await setSwitch(`${n} on or off`, false);
await sleep(4000);
await probe("all-off-a");
await sleep(6000);
await probe("all-off-b");
await closeSettings();
await finish();
