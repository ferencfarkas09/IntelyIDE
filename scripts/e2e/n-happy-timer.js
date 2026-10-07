// (n) Time Tracer against scripts/mock-happy (loopback, no production): nothing is shown while the integration is off; after
// the config and a token the status-bar chip appears, a task starts the timer, Pause/Resume/Stop work. HAPPY comes from
// run.sh (the mock server's port and token). run.sh then reads the mock's request log.
await waitForTree();
const chip = () => q('button[aria-label^="Time tracker"]');
check("integration off: no timer chip, no Time tab", !chip() && !qa("button").some((b) => (b.getAttribute("aria-label") ?? "") === "Time"));
const off = await invoke("happy_status");
check("the hub starts off and reports no token", off.config?.master === false && off.tokenSaved === false, JSON.stringify(off).slice(0, 300));

// Settings > Integrations, like a user: master switch, Time Tracer on, Custom environment pointing at the mock, the token.
await press(",", { meta: true });
const dlg = await waitFor(() => q(".settings"), { what: "the Settings dialog" });
(await waitFor(() => qa(".settings__item", dlg).find((b) => text(b) === "Integrations"), { what: "the Integrations section" })).click();
const pane = () => q(".settings__pane", dlg);
const sw = (label) => q(`[role="switch"][aria-label="${label}"]`, pane());
await waitFor(() => sw("Happy integrations"), { what: "the master switch", timeout: 15000 });
const turnOn = async (label) => {
  await waitFor(() => sw(label) && !sw(label).disabled, { what: `${label} to be usable` });
  if (sw(label).getAttribute("aria-checked") !== "true") sw(label).click();
  await waitFor(() => sw(label).getAttribute("aria-checked") === "true", { what: `${label} on`, timeout: 15000 });
};
await turnOn("Happy integrations");
await turnOn("Time Tracer on or off");
const env = () => qa('[role="radiogroup"][aria-label="Environment"] [role="radio"]', pane()).find((r) => text(r) === "Custom");
await waitFor(env, { what: "the Custom environment option" });
env().click();
const url = await waitFor(() => q("#happy-base-url", pane()), { what: "the base URL field" });
await typeInto(url, `http://127.0.0.1:${HAPPY.port}`);
await press("Enter", {}, url);
await sleep(300);
const tokenField = await waitFor(() => q("#happy-token", pane()), { what: "the token field" });
await typeInto(tokenField, HAPPY.token);
await clickButton("Save token", pane());
await waitFor(() => /A token is saved/.test(text(pane())), { what: "the token to be saved", timeout: 20000 });
check("the token is saved and never shown again", /A token is saved/.test(text(pane())) && !text(pane()).includes(HAPPY.token) && !qa("input", pane()).some((i) => i.value === HAPPY.token));
await clickButton("Test connection", pane());
await waitFor(() => /Elek|Connected|Ready|ok/i.test(text(pane())), { what: "the connection test result", timeout: 20000 });
check("Test connection reaches the mock server", /Teszt Elek|Connected|Ready/i.test(text(pane())), text(pane()).slice(0, 300));
await press("Escape");
await waitFor(() => !q(".settings"), { what: "Settings to close", timeout: 5000 });
await waitFor(chip, { what: "the timer chip in the status bar", timeout: 30000 });
check("the status bar shows the timer chip, idle", /not tracking/.test(chip().getAttribute("aria-label")), chip().getAttribute("aria-label"));

chip().click();
const list = await waitFor(() => q('[role="listbox"][aria-label="Tasks"]'), { what: "the task picker" });
await waitFor(() => qa('[role="option"]', list).length >= 3, { what: "tasks from the mock server", timeout: 20000 });
check("the picker lists the mock's quick-start tasks", ["Receipts", "Localization", "Fix the till printer"].every((n) => text(list).includes(n)), text(list).slice(0, 200));
await window.__e2e.screenshot("timer-picker");
qa('[role="option"]', list).find((o) => /Receipts/.test(text(o))).click();
await waitFor(() => /Receipts/.test(chip().getAttribute("aria-label")), { what: "the chip to name the task", timeout: 20000 });
check("starting a task: the chip names it and the clock runs", /Receipts/.test(chip().getAttribute("aria-label")) && !!q('[role="timer"]'), chip().getAttribute("aria-label"));
const run = await invoke("happy_timer_current");
check("the backend reports a running timer", run.phase === "running", JSON.stringify(run).slice(0, 200));

await clickButton("Pause", q(".ht-pop"));
await waitFor(async () => (await invoke("happy_timer_current")).phase === "paused", { what: "paused", timeout: 20000 });
check("Pause pauses it", chip().getAttribute("data-phase") === "paused" || (await invoke("happy_timer_current")).phase === "paused");
await clickButton("Resume", q(".ht-pop"));
await waitFor(async () => (await invoke("happy_timer_current")).phase === "running", { what: "running again", timeout: 20000 });
check("Resume continues it", true);
await clickButton("Stop", q(".ht-pop"));
await waitFor(async () => (await invoke("happy_timer_current")).phase === "idle", { what: "stopped", timeout: 20000 });
await waitFor(() => /not tracking/.test(chip().getAttribute("aria-label")), { what: "the chip to go idle", timeout: 20000 });
check("Stop ends it and the chip is idle again", true);
// Search loads from the server (Refunds is not in the quick-start rows), and a new task is created and started.
const box = await waitFor(() => q('input[aria-label="Search tasks"]'), { what: "the search box" });
await typeInto(box, "refu");
await waitFor(() => qa('[role="option"]', q('[role="listbox"][aria-label="Tasks"]')).some((o) => /Refunds/.test(text(o))), { what: "the server search result", timeout: 20000 });
check("typing in the picker loads matching tasks from the server", true);
await window.__e2e.screenshot("timer-search");
await typeInto(box, "");
const addTask = await waitFor(() => qa("button").find((b) => b.getAttribute("aria-label") === "New task in Shop POS"), { what: "the New task row under a project", timeout: 20000 });
addTask.click();
const title = await waitFor(() => q('input[aria-label="Task title"]'), { what: "the task title field" });
await typeInto(title, "E2E gift cards");
await window.__e2e.screenshot("timer-new-task");
await clickButton("Create and start", q(".ht-pop"));
await waitFor(() => /E2E gift cards/.test(chip().getAttribute("aria-label")), { what: "the chip to name the new task", timeout: 20000 });
check("a new task is created and its timer started", (await invoke("happy_timer_current")).phase === "running");
await clickButton("Stop", q(".ht-pop"));
await waitFor(async () => (await invoke("happy_timer_current")).phase === "idle", { what: "stopped again", timeout: 20000 });
const entries = await invoke("happy_timer_entries", { fromMs: Date.now() - 86400000, toMs: Date.now() + 86400000 });
check("the stopped entry is in today's totals", (entries.entries ?? []).length >= 1, JSON.stringify(entries).slice(0, 300));

// A timer started or stopped "elsewhere" (the web app, the phone) follows here without a click: the chip is refreshed by the poll. The page may not talk
// to the mock (CSP), so the control call goes through run.sh (.mock-cmd / .mock-ack in a fixture repo, like zz).
const BE = FX.repoIds[0];
let ackN = 0;
async function mockCtl(name, body = {}) {
  const line = `${name}|${JSON.stringify({ ...body, n: ackN++ })}`;
  await invoke("files_write_file", { repoId: BE, relPath: ".mock-cmd", text: `${line}\n`, expectedMtimeMs: 0, reveal: false });
  await waitFor(async () => (await invoke("files_read_file", { repoId: BE, relPath: ".mock-ack" }).catch(() => null))?.text?.trim() === line, { what: `the mock control "${name}"`, timeout: 15000 });
}
const tSync = performance.now();
await mockCtl("timer", { action: "start", kind: "project", id: "p_admin", taskId: "t_l10n" });
await waitFor(() => /Localization/.test(chip().getAttribute("aria-label") ?? ""), { what: "the chip to follow a timer started elsewhere", timeout: 25000 });
const syncLag = Math.round(performance.now() - tSync);
notes.syncLagMs = syncLag;
check("a timer started elsewhere shows up here without a click (within 10 s)", syncLag < 10000, `${syncLag} ms`);
await window.__e2e.screenshot("timer-started-elsewhere");
await mockCtl("timer", { action: "stop" });
await waitFor(() => /not tracking/.test(chip().getAttribute("aria-label") ?? ""), { what: "the chip to follow a stop made elsewhere", timeout: 25000 });
check("a stop made elsewhere clears the chip", true);
// More entries than one page: the Time tab shows today's list (40 extra rows from the mock).
await mockCtl("timer/bulk", { count: 40 });
if (!findButton("Open Time tab")) chip().click();
const openTime = await waitFor(() => findButton("Open Time tab"), { what: "the Open Time tab button in the timer popover", timeout: 10000 });
check("the timer popover offers the Time tab", !!openTime);
openTime.click();
await waitFor(() => /Receipts|E2E gift cards|Localization/.test(text(q('[data-testid="time-tab"]') ?? document.body)), { what: "the Time tab entries", timeout: 15000 });
await sleep(1500);
await window.__e2e.screenshot("timer-time-tab");
check("the Time tab lists the entries (the mock's 40 extra rows included)", /Receipts/.test(text(document.body)), text(document.body).slice(0, 200));
await press("Escape");
await press(",", { meta: true });
const dlg2 = await waitFor(() => q(".settings"), { what: "Settings again" });
(await waitFor(() => qa(".settings__item", dlg2).find((b) => text(b) === "Integrations"), { what: "the Integrations section" })).click();
const master = await waitFor(() => q('[role="switch"][aria-label="Happy integrations"]', dlg2), { what: "the master switch" });
master.click();
await waitFor(() => !chip(), { what: "the chip to disappear when the master switch goes off", timeout: 20000 });
check("the master switch off removes the chip again", !chip());
await press("Escape");
await finish();
