// (zu) Night queue, Morning brief, session search and the context cockpit in the real window, against the mock provider:
// enable the two extras in Settings, prepare three runs (two plain replies, one that waits for a permission nobody answers, on a one-minute
// budget), start the night, watch them go one at a time, see the budget stop the third, read the brief, search the runs and open
// the cockpit. Needs INTELY_MOCK_PROVIDER=1, INTELY_AGENTUX_FAKE=1 and INTELY_FAKE_POWER=ac (run.sh sets them). Nothing is
// written to the repos; the harness checks that and the Rewind snapshot refs.
await waitForTree();
const ws = await invoke("workspace_get");
const nameOf = (id) => ws.repos.find((r) => r.id === id).name;
const [BACKEND, ADMIN, SERVICES] = FX.repoIds.map(nameOf);

async function runCommand(search, expect) {
  await press("p", { meta: true, shift: true });
  const palette = await waitFor(() => q(".palette"), { what: "the command palette" });
  const field = await waitFor(() => q('[role="combobox"]', palette), { what: "the palette search field" });
  await typeInto(field, search);
  await waitFor(() => qa('[role="option"]', palette).some((o) => expect.test(text(o))), { what: `the palette command ${expect}` });
  await press("Enter", {}, field);
}

// ---- enable the extras in Settings -------------------------------------------------------------------------------
step("enable");
await press(",", { meta: true });
const settings = await waitFor(() => q(".settings"), { what: "the Settings dialog" });
const item = (name) => qa(".settings__item", settings).find((b) => text(b) === name);
await waitFor(() => item("Night queue") && item("Session search"), { what: "the two new Settings sections" });
check("Settings lists Night queue and Session search (both off by default)", !!item("Night queue") && !!item("Session search"), qa(".settings__item", settings).map(text).join(","));
check("nothing is registered while the extras are off", !(await commandTitles()).some((t) => /Night queue|Search sessions/.test(t)), "");
async function commandTitles() {
  await press("p", { meta: true, shift: true });
  const palette = await waitFor(() => q(".palette"), { what: "the command palette" });
  await waitFor(() => qa('[role="option"]', palette).length > 5, { what: "palette options" });
  const titles = qa('[role="option"]', palette).map(text);
  await press("Escape");
  return titles;
}
for (const [section, aria] of [["Night queue", "Enable the night queue and Morning brief"], ["Session search", "Enable session search and context cockpit"]]) {
  item(section).click();
  const sw = await waitFor(() => q(`[aria-label="${aria}"]`, settings), { what: `the ${section} switch` });
  sw.click();
  await waitFor(() => sw.getAttribute("aria-checked") === "true" || sw.checked === true, { what: `${section} switched on` });
}
await press("Escape");
await waitFor(() => !q(".settings"), { what: "Settings to close", timeout: 5000 });

// ---- prepare the night -------------------------------------------------------------------------------------------
step("queue");
await runCommand("Night queue", /Night queue: prepare/);
await waitFor(() => q(".nq"), { what: "the Night queue tab" });
check("the queue starts empty, with Start disabled", /Nothing prepared yet/.test(text(q(".nq"))) && findButton("Start the night")?.disabled, text(q(".nq")).slice(0, 200));

async function addNight(role, repoName, prompt, minutes) {
  await clickButton("Add a run", q(".nq"));
  const sel = await waitFor(() => q('select[aria-label="Role"]', q(".nq")), { what: "the role select" });
  await waitFor(() => [...sel.options].some((o) => o.value === role), { what: `role ${role} in the list`, timeout: 20000 });
  sel.value = role;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(() => qa(".nq__repos label").length >= 4, { what: "the repo list" });
  for (const l of qa(".nq__repos label")) {
    const box = q('input[type="checkbox"]', l);
    if (box.checked !== text(l).includes(repoName)) box.click(); // the form keeps the last selection: set it exactly
  }
  await typeInto(q('textarea[aria-label="Prompt"]', q(".nq")), prompt);
  await typeInto(q('input[aria-label="Time budget (minutes)"]', q(".nq")), String(minutes));
  await sleep(100);
  await clickButton("Add to the queue", q(".nq"));
  await waitFor(() => !q('textarea[aria-label="Prompt"]', q(".nq")), { what: "the form to close" });
}
await addNight("mock-plain-reply", BACKEND, "say hello", 5);
await addNight("mock-plain-reply", ADMIN, "say hello again", 5);
await addNight("mock-tool-permission", SERVICES, "write a note", 1);
check("three runs are prepared, listed in order", qa(".nq__item").length === 3 && /3 of 8 runs prepared/.test(text(q(".nq"))), text(q(".nq")).slice(0, 300));
await shot("night-queue-prepared");

// ---- the night ---------------------------------------------------------------------------------------------------
step("night");
await clickButton("Start the night", q(".nq"));
let maxRunning = 0;
await waitFor(() => {
  const states = qa(".nq__item").map((i) => i.getAttribute("data-state"));
  maxRunning = Math.max(maxRunning, states.filter((s) => s === "running").length);
  return states.filter((s) => s === "done").length >= 2;
}, { what: "the two plain runs to finish", timeout: 120000, interval: 150 });
check("the runs went one at a time", maxRunning <= 1, String(maxRunning));
await shot("night-queue-running");
await waitFor(() => qa(".nq__item")[2]?.getAttribute("data-state") === "stopped", { what: "the one-minute budget to stop the third run", timeout: 150000, interval: 250 });
const third = text(qa(".nq__item")[2]);
check("the third run was stopped by its time budget, with the reason shown", /time budget ran out/.test(third), third);
await waitFor(async () => (await invoke("agentux_night_state")).armed === false, { what: "the queue to disarm itself", timeout: 15000, interval: 500 }).catch(() => {});
const night = await invoke("agentux_night_state");
check("the night disarms itself when the queue is done", night.armed === false && night.items.map((i) => i.state).join(",") === "done,done,stopped", JSON.stringify(night.items.map((i) => i.state)));
const list = await invoke("agent_list");
check("three runs exist: the roles of the queue, on the repos of the queue", list.length === 3 && list.some((a) => a.role === "mock-tool-permission"), list.map((a) => a.role).join(","));
const hist = [];
for (const it of night.items) hist.push({ id: it.runId, ev: await historyOf(it.runId) });
const span = (h) => [h.ev.events[0].ts, h.ev.events.at(-1).ts];
check("the second run started after the first one ended (single writer, one at a time)", span(hist[1])[0] >= span(hist[0])[1] && span(hist[2])[0] >= span(hist[1])[1], JSON.stringify(hist.map(span)));
check("every stored log is gap-free", hist.every((h) => h.ev.problems.length === 0), hist.map((h) => h.ev.problems.join(";")).join("|"));
await shot("night-queue-done");

// ---- the Morning brief -------------------------------------------------------------------------------------------
step("brief");
const radio = qa('[role="radio"]').find((r) => text(r) === "Morning brief");
radio.click();
await waitFor(() => qa(".bf__run").length === 3, { what: "three runs in the brief", timeout: 30000 });
check("the brief lists the night's three runs with an Open review button each", qa(".bf__run").length === 3 && qa(".bf__run").every((r) => !!findButton("Open review", r)), text(q(".bf")).slice(0, 300));
check("a mock run changed nothing, so its repos say No changes (untouched dirty files are not reported)", qa(".bf__run").slice(0, 2).every((r) => /No changes/.test(text(r))), text(q(".bf")).slice(0, 400));
check("the totals count three runs", /Runs\s*3/.test(text(q(".bf__totals"))), text(q(".bf__totals")));
check("the brief says nothing was committed or pushed", /Nothing was committed or pushed/.test(text(q(".bf"))));
await clickButton("Summarise with Haiku", q(".bf"));
await waitFor(() => /Summary \(fake model\)/.test(text(q(".bf"))), { what: "the (fake) summary", timeout: 20000 });
check("the summary appears only after the click", /Summary \(fake model\)/.test(text(q(".bf"))));
await shot("morning-brief");
await clickButton("Open review", qa(".bf__run")[0]);
await waitFor(() => qa('[role="tab"]').some((t) => /^Review/.test(text(t))), { what: "the review tab of the run", timeout: 20000 });
check("Open review opens the review tab of that run", true);

// ---- session search and the cockpit ------------------------------------------------------------------------------
step("search");
await runCommand("Search sessions", /Search sessions/);
await waitFor(() => qa(".hs__hit").length >= 3, { what: "the indexed runs", timeout: 30000 });
check("the search lists the three runs, built from the event logs", qa(".hs__hit").length === 3, String(qa(".hs__hit").length));
await typeInto(q(".hs__bar input"), "hello");
await waitFor(() => qa(".hs__hit").length === 2, { what: "two runs match hello", timeout: 20000 });
check("a word narrows the list and is highlighted", qa(".hs__hit mark").length > 0 && qa(".hs__hit mark").every((m) => /hello/i.test(text(m))), text(q(".hs__list")).slice(0, 300));
await typeInto(q(".hs__bar input"), "mock-tool-permission");
await waitFor(() => qa(".hs__hit").length === 1, { what: "one run for the role", timeout: 20000 });
await shot("session-search");
await clickButton("Context", q(".hs__hit"));
await waitFor(() => q(".cp .cp__card"), { what: "the context cockpit", timeout: 20000 });
check("the cockpit shows the context window and the usage section", /Context window/.test(text(q(".cp"))) && /Usage/.test(text(q(".cp"))), text(q(".cp")).slice(0, 300));
await shot("context-cockpit");
await finish({ states: night.items.map((i) => i.state).join(",") });
