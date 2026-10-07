// (jc) LIVE Claude (Haiku, role developer) in PLAN mode: nothing is written before the plan is approved; the approval card (ExitPlanMode) carries the plan;
// approving with "Edit automatically" switches the run, the files then exist, the run ends Done, git untouched. Then a second Plan run whose card is
// REJECTED with a note: the note reaches the model (a revised plan comes back), the run stays in Plan, nothing is written. Needs the claude CLI login.
await waitForTree();
await openAgents();
const ws = await invoke("workspace_get");
const POS = ws.repos.find((r) => r.id === "shop-pos").name;
const PROMPT =
  "This is an automated test in a throwaway repository. Plan, then implement: create util.js in the repository root with a function double(n) that returns n * 2 " +
  "(CommonJS: module.exports = { double }), and a test file util.test.js that checks double(4) equals 8 using node:assert. Do not run anything, do not commit, stage or push. Keep it small.";

step("plan run 1: approve");
await newRoleRun("developer", [POS], PROMPT, "readOnly");
const denied = [];
const card = await waitFor(planCard, { what: "the plan approval card", timeout: 150000 });
check("the header chip reads Plan while planning", /Plan/.test(chipLabel()), chipLabel());
check("the card carries a plan text that mentions double", /double/i.test(text(card)) && text(card).length > 80, text(card).slice(0, 300));
check("the card offers Edit automatically and never Bypass", qa(".mode-card", card).some((c) => c.dataset.mode === "edit") && !qa(".mode-card", card).some((c) => c.dataset.mode === "bypass"), qa(".mode-card", card).map((c) => c.dataset.mode).join());
check("nothing was written before the approval (util.js)", (await readRepoFile("util.js")) === null, String(await readRepoFile("util.js")));
check("nothing was written before the approval (util.test.js)", (await readRepoFile("util.test.js")) === null, String(await readRepoFile("util.test.js")));
await shot("plan-card");
const editCard = qa(".mode-card", card).find((c) => c.dataset.mode === "edit");
(editCard ?? qa(".mode-card", card).find((c) => c.dataset.mode === "automatic"))?.click();
notes.approvedWith = (editCard ? "edit" : "automatic");
findButton("Approve plan", card).click();
await waitFor(() => /Edit automatically|Automatic/.test(chipLabel()), { what: "the header chip to leave Plan", timeout: 30000 });
check("approving switched the run mode (chip)", /Edit automatically|Automatic/.test(chipLabel()), chipLabel());
let hung = null;
await untilSettled({ timeout: 200000, denied }).catch((e) => { hung = String(e.message).slice(0, 600); });
notes.deniedByMe = denied;
const shown1 = panelText();
check("run 1 ended Done", !hung && runStatusText() === "Done", hung ?? `${runStatusText()} | ${shown1.slice(0, 400)}`);
if (hung) { // keep going: the files and the second half are still worth checking; end the stuck run with Interrupt
  await clickButton("Interrupt", agentsPanel()).catch(() => {});
  await waitFor(() => settled(), { what: "Done after Interrupt of the stuck run", timeout: 30000 }).catch(() => {});
}
check("no permission card needed after the approval", denied.length === 0, denied.join(" || "));
const util = await readRepoFile("util.js");
const test = await readRepoFile("util.test.js");
check("util.js exists with double", /double/.test(util ?? ""), JSON.stringify(util));
check("util.js doubles its argument (module.exports = { double }, n * 2)", /double/.test(util ?? "") && /(n\s*\*\s*2|2\s*\*\s*n|n\s*\+\s*n)/.test(util ?? "") && /module\.exports|export /.test(util ?? ""), JSON.stringify(util));
check("util.test.js exists and exercises double", /double/.test(test ?? "") && /8/.test(test ?? ""), JSON.stringify(test));
const run1 = await latestRun();
const h1 = await historyOf(run1.agentId);
check("run 1 log is gap-free and paired", h1.problems.length === 0, h1.problems.join("; "));
notes.turnEnds1 = h1.events.filter((e) => e.kind === "turn.end").map((e) => e.seq);
check("the log records the plan approval switch", h1.events.some((e) => e.kind === "session.info" && /planApproved/.test(JSON.stringify(e.effective ?? {}))), h1.events.filter((e) => e.kind === "session.info").map((e) => JSON.stringify(e.effective ?? {})).join(" ").slice(0, 300));
const approvedSeq = h1.events.find((e) => e.kind === "session.info" && /planApproved/.test(JSON.stringify(e.effective ?? {})))?.seq ?? Infinity;
const afterPlan = h1.events.filter((e) => e.seq > approvedSeq && e.kind === "permission.request");
check("run 1 raised no permission request after the plan approval", afterPlan.length === 0, `${afterPlan.length} after seq ${approvedSeq}: ${permLines(h1.events).join(" ## ").slice(0, 400)}`);
notes.perm1 = permLines(h1.events);
await shot("plan-approved-done");

step("plan run 2: reject with a note");
await backToRuns();
await newRoleRun("developer", [POS], "This is an automated test in a throwaway repository. Plan (do not implement yet): create a file greet.js in the repository root with a function greet(name) that returns 'hi ' + name. Keep it small.", "readOnly");
const card2 = await waitFor(planCard, { what: "the second plan approval card", timeout: 150000 });
findButton("Request changes", card2).click();
const note = await waitFor(() => q(".plan-approval__feedback textarea", card2), { what: "the feedback field" });
const NOTE = "Keep greet, but also add a second function farewell(name) that returns 'bye ' + name, and name farewell explicitly in the revised plan.";
await typeInto(note, NOTE);
findButton("Send feedback", card2).click();
const card3 = await waitFor(() => { const c = planCard(); return c && c !== card2 && c.isConnected ? c : null; }, { what: "a revised plan card", timeout: 150000 });
check("the note reached the model: the revised plan names farewell", /farewell/.test(text(card3)), text(card3).slice(0, 300));
check("the run is still in Plan", /Plan/.test(chipLabel()), chipLabel());
check("nothing was written (greet.js)", (await readRepoFile("greet.js")) === null);
const run2 = await latestRun();
const h2 = await historyOf(run2.agentId);
notes.perm2 = permLines(h2.events);
check("run 2 log is gap-free so far (the turn is still open)", !h2.problems.some((p) => /^seq/.test(p)), h2.problems.join("; "));
await shot("plan-rejected-revised");
await clickButton("Interrupt", agentsPanel());
await waitFor(() => settled(), { what: "Done after Interrupt", timeout: 30000 }).catch((e) => check("Interrupt of a run waiting on the plan card ends the run", false, `${runStatusText()} | ${String(e.message).slice(0, 200)}`));
notes.perm2After = permLines((await historyOf(run2.agentId)).events);
check("the interrupted plan run wrote nothing", (await readRepoFile("greet.js")) === null);

step("plan run 3: the Explore sub-agent stays inside one turn, Stop works during it");
await backToRuns();
await newRoleRun("developer", [POS], "This is an automated test in a throwaway repository. FIRST launch the Explore sub-agent (the Agent tool with subagent_type Explore) to list every file in the repository and count the lines of package.json. Only after its report come back, present a one-paragraph plan to add a README line. Do not write anything.", "readOnly");
const run3 = await latestRun();
let sawAgent = false;
for (let i = 0; i < 240 && !sawAgent && !planCard(); i++) {
  sawAgent = (await historyOf(run3.agentId)).events.some((e) => e.kind === "tool.start" && /^(Agent|Task)$/.test(e.name));
  if (!sawAgent) await sleep(500);
}
if (sawAgent) {
  await sleep(1500); // the sub-agent is running now
  await clickButton("Interrupt", agentsPanel());
  await waitFor(() => settled(), { what: "Done after Stop during the sub-agent", timeout: 45000 })
    .catch((e) => check("Stop during the Explore sub-agent ends the run", false, `${runStatusText()} | ${String(e.message).slice(0, 200)}`));
  await sleep(1500);
  const h3 = await historyOf(run3.agentId);
  const afterUser = h3.events.filter((e) => e.seq > (h3.events.find((x) => x.kind === "user.message")?.seq ?? 0));
  const unturned = afterUser.filter((e) => !e.turnId && !/^(session\.info|status|usage)$/.test(e.kind));
  notes.run3 = { events: h3.events.length, turnEnds: h3.events.filter((e) => e.kind === "turn.end").map((e) => e.seq), unturned: unturned.slice(0, 8).map((e) => `${e.seq}:${e.kind}`), status: runStatusText() };
  check("run 3: every event after the user message belongs to a turn", unturned.length === 0, JSON.stringify(notes.run3));
  check("run 3: exactly one turn.end and the log is paired", h3.events.filter((e) => e.kind === "turn.end").length === 1 && h3.problems.length === 0, JSON.stringify(notes.run3) + h3.problems.join("; "));
  check("run 3: Stop during the sub-agent ended the run (Done)", runStatusText() === "Done", runStatusText());
} else {
  skip("run 3: Explore sub-agent", "the model did not launch an Agent call before the plan card");
  if (!planCard()) await clickButton("Interrupt", agentsPanel()).catch(() => {});
}
await finish({ transcript: shown1.slice(0, 800) });
