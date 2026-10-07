// (z) An ACP provider (the Gemini profile) through the real chain: New run provider picker limited by tier, the sidecar, the ACP adapter,
// the policy broker, the event log and the dock UI. The "agent" is the scripted fake in sidecar/tests/fakes (INTELY_E2E_ACP_FAKES); no CLI
// and no model call. A stub `gemini` on INTELY_E2E_EXTRA_PATH makes the provider detectable. Three scripted runs: a streamed answer, a shell
// command that needs Allow once / Deny, and a terminal `git push` that the hard stop refuses. The fake proves our protocol handling, not
// Gemini's behaviour: the provider stays Weak and only the scripted roles may write.
await waitForTree();
await openAgents();
const REPO = FX.repoIds[0];
const ACP_ROLES = ["mock-acp-plain-reply", "mock-acp-asks-command", "mock-acp-terminal-git-push"];

// ---- roles and provider state ---------------------------------------------------------------------------------------------------------------
const roles = await invoke("agent_roles");
const roleOf = (n) => roles.find((r) => r.name === n);
check("the scripted ACP roles are offered on provider gemini", ACP_ROLES.every((n) => roleOf(n)?.provider === "gemini"), roles.map((r) => `${r.name}:${r.provider}`).join(","));
check("the Claude roles are there (developer edits, researcher reads)", roleOf("developer")?.provider === "claude" && roleOf("developer")?.permission === "edit" && roleOf("researcher")?.permission === "readOnly", JSON.stringify([roleOf("developer"), roleOf("researcher")].map((r) => r && [r.provider, r.permission])));
// Wave4: a non-Claude provider needs the global Experimental providers switch, its own switch and a confirmed command line
await invoke("providers_experimental_set", { on: true });
await invoke("providers_set_enabled", { id: "gemini", enabled: true });
const detected0 = await invoke("providers_detect");
const gem0 = detected0.find((p) => p.id === "gemini");
check("Gemini is detected through the stub CLI but waits for its command line to be confirmed", gem0?.state === "needsConfirm" && /stubbin/.test(gem0?.cli?.path ?? ""), JSON.stringify([gem0?.state, gem0?.cli?.path]));
await invoke("providers_confirm_launch", { id: "gemini", command: gem0.cli.path, args: ["--acp"] });
const detected = await invoke("providers_list");
const gem = detected.find((p) => p.id === "gemini");
check("Gemini is ready once the exact command line was confirmed (stored with a fingerprint)", gem?.state === "ready" && gem?.launch?.status === "confirmed" && /^[0-9a-f]{16}$/.test(gem?.launch?.hash ?? ""), JSON.stringify([gem?.state, gem?.launch?.status, gem?.launch?.hash]));
const enf = await invoke("providers_enforcement");
check("no suite is recorded for Gemini: the backend reports nothing for it (read as Weak)", !enf.some((e) => e.provider === "gemini"), JSON.stringify(enf));
const caps = await invoke("roles_capabilities");
check("the roles backend can run Gemini for read-only roles only", caps.some((c) => c.provider === "gemini" && c.models.length > 0 && c.permissionModes.join() === "readOnly"), JSON.stringify(caps.map((c) => [c.provider, c.permissionModes])));

// ---- the New run provider picker, limited by tier ---------------------------------------------------------------------------------------------
// The back button of a selected run reads "Runs" plus a badge while a run needs me, so it is found by prefix.
async function backToRuns() {
  const back = qa(".chat__bar button", agentsPanel()).find((b) => /^Runs/.test(text(b)));
  if (back) { back.click(); await sleep(300); }
}
async function openNewRun() {
  await backToRuns();
  await clickButton("New run", agentsPanel());
  const pop = await waitFor(() => q(".newrun"), { what: "the New run popover" });
  await roleMode(pop);
  return pop;
}
async function pickRole(pop, role) {
  const radio = await waitFor(() => qa('[role="radio"]', pop).find((b) => text(b).startsWith(role)), { what: `role ${role}` });
  radio.click();
  await waitFor(() => radio.getAttribute("aria-checked") === "true", { what: `role ${role} picked` });
  await sleep(250);
}
const providerRadio = (pop, name) => qa('[role="radiogroup"][aria-label="Provider"] [role="radio"]', pop).find((b) => text(b).includes(name));
const pop = await openNewRun();
await pickRole(pop, "developer");
await waitFor(() => providerRadio(pop, "Gemini"), { what: "the Gemini choice in the picker", timeout: 20000 });
check("developer (edits files): Claude is chosen, Gemini is greyed out with the reason", providerRadio(pop, "Claude")?.getAttribute("aria-checked") === "true" && providerRadio(pop, "Gemini")?.getAttribute("aria-disabled") === "true" && /read-only/i.test(providerRadio(pop, "Gemini")?.getAttribute("title") ?? ""), `${providerRadio(pop, "Gemini")?.outerHTML.slice(0, 260)}`);
notes.geminiWriteReason = providerRadio(pop, "Gemini")?.getAttribute("title");
providerRadio(pop, "Gemini").click();
await sleep(200);
check("clicking a greyed-out provider changes nothing", providerRadio(pop, "Claude")?.getAttribute("aria-checked") === "true" && providerRadio(pop, "Gemini")?.getAttribute("aria-checked") !== "true");
await shot("picker-developer-gemini-greyed");
await pickRole(pop, "researcher");
check("researcher (read-only): Gemini can be picked", providerRadio(pop, "Gemini")?.getAttribute("aria-disabled") !== "true", providerRadio(pop, "Gemini")?.outerHTML.slice(0, 260));
providerRadio(pop, "Gemini").click();
await waitFor(() => providerRadio(pop, "Gemini").getAttribute("aria-checked") === "true", { what: "Gemini picked" });
notes.pickerNote = text(q(".newrun__provider-note", pop));
await shot("picker-researcher-gemini");
await pickRole(pop, "mock-acp-asks-command");
const startBtn = () => findButton("Start run", pop);
check("a scripted write role on Gemini cannot be started from the dialog", startBtn()?.disabled === true || startBtn()?.getAttribute("aria-disabled") === "true", `${startBtn()?.outerHTML.slice(0, 200)} / ${text(q(".newrun__provider-note", pop))}`);
await shot("picker-write-role-blocked");
await pickRole(pop, "researcher");
providerRadio(pop, "Gemini").click();
await waitFor(() => providerRadio(pop, "Gemini").getAttribute("aria-checked") === "true", { what: "Gemini picked again" });
for (const b of qa('[aria-label="Repositories"] button', pop)) {
  const want = text(b).includes("shop-backend");
  if ((b.getAttribute("aria-pressed") === "true") !== want) b.click();
}
await typeInto(q('textarea[aria-label="Prompt"]', pop), "say hello");
await clickButton("Start run", pop);
await waitFor(() => q(".run-header"), { what: "the run header after Start", timeout: 60000 });

// ---- 1. researcher on Gemini: a read-only run through the ACP adapter ------------------------------------------------------------------------------
await waitFor(() => /Hello from the ACP fake/.test(panelText()), { what: "the streamed text of the ACP agent", timeout: 60000 });
await waitFor(() => runStatusText() === "Done", { what: "Done", timeout: 30000 });
const header = text(q(".run-header"));
check("1 the run header names the provider and its tier (Weak: nothing recorded)", /Gemini/.test(header) && /Enforcement: Weak/.test(header), header.slice(0, 240));
await shot("run-gemini-readonly");
const list1 = await invoke("agent_list");
check("1 agent_list: the researcher run is on gemini, tier weak, done", list1.length === 1 && list1[0].provider === "gemini" && list1[0].role === "researcher" && list1[0].enforcement === "weak" && list1[0].status === "done", JSON.stringify(list1.map((a) => [a.provider, a.role, a.enforcement, a.status])));

// ---- 2. the server refuses what the picker greys out ------------------------------------------------------------------------------------------
const refused = await invoke("agent_start", { req: { role: "developer", repoIds: [REPO], prompt: "x", provider: "gemini" } }).then(() => "started", (e) => e?.code ?? String(e));
check("2 agent_start: a write role on Gemini is refused by the backend (providerReadOnly)", refused === "providerReadOnly", refused);
check("2 the refusal left no run behind", (await invoke("agent_list")).length === 1);

// ---- helpers for the scripted write roles (started through the command: the dialog blocks them) -------------------------------------------------
async function startScripted(role, prompt) {
  const run = await invoke("agent_start", { req: { role, repoIds: [REPO], prompt } });
  await sleep(300);
  await backToRuns();
  const row = await waitFor(() => qa(".runs__row", agentsPanel()).find((r) => text(q(".runs__meta", r)).startsWith(role)), { what: `the ${role} row in the run list`, timeout: 20000 });
  row.click();
  await waitFor(() => q(".run-header"), { what: `the ${role} run header` });
  return run;
}

// ---- 3. a permission request of the ACP agent: Allow once, then Deny -------------------------------------------------------------------------
const askRun = await startScripted("mock-acp-asks-command", "install the package");
const card = await waitFor(permissionCard, { what: "the permission card of the ACP agent", timeout: 60000 });
check("3 the card names the command and the run needs me", /npm install left-pad/.test(text(card)) && runStatusText() === "Needs you", `${text(card).slice(0, 200)} / ${runStatusText()}`);
check("3 only the offered choices are rendered (no Always)", !!findButton("Allow once", card) && !!findButton("Deny", card) && !findButton("Always for role + repo", card), text(card));
await shot("acp-permission-card");
findButton("Allow once", card).click();
await waitFor(() => /answer=selected:allow/.test(panelText()), { what: "the agent to report the answer", timeout: 30000 });
await waitFor(() => runStatusText() === "Done", { what: "Done after Allow once" });
check("3 Allow once reaches the agent as allow_once", /answer=selected:allow/.test(panelText()), panelText().slice(0, 300));
const askRun2 = await startScripted("mock-acp-asks-command", "install it again");
const card2 = await waitFor(permissionCard, { what: "the second permission card", timeout: 60000 });
findButton("Deny", card2).click();
await waitFor(() => /answer=selected:reject/.test(panelText()), { what: "the agent to report the denial", timeout: 30000 });
await waitFor(() => runStatusText() === "Done", { what: "Done after Deny" });
check("3 Deny reaches the agent as reject_once", /answer=selected:reject/.test(panelText()), panelText().slice(0, 300));
const forged = await invoke("agent_answer_permission", { agentId: askRun.agentId, requestId: "forged", decision: "allowOnce" }).then(() => "accepted", (e) => e.code);
check("3 a forged answer is refused by the host", forged === "unknownRequest" || forged === "notRunning", forged);

// ---- 4. a terminal git push: refused by the hard stop, no card --------------------------------------------------------------------------------
const pushRun = await startScripted("mock-acp-terminal-git-push", "push it");
await waitFor(() => /git push is human-only/.test(panelText()), { what: "the hard stop message", timeout: 60000 });
await waitFor(() => runStatusText() === "Done", { what: "Done after the refused push" });
check("4 the push is refused by a hard stop, without asking", /blocked by policy/.test(panelText()) && !permissionCard(), panelText().slice(0, 400));
await shot("acp-push-refused");

// ---- the stored logs --------------------------------------------------------------------------------------------------------------------------
const all = await invoke("agent_list");
check("all four runs are listed, all on gemini, none above Weak", all.length === 4 && all.every((a) => a.provider === "gemini" && a.enforcement === "weak"), JSON.stringify(all.map((a) => [a.role, a.provider, a.enforcement, a.status])));
for (const a of all) {
  const h = await historyOf(a.agentId);
  check(`log of ${a.role}: gap-free, tools and turns paired`, h.problems.length === 0 && h.turns >= 1, `${h.problems.join("; ")} turns=${h.turns}`);
  notes[`kinds-${a.role}-${a.agentId.slice(-4)}`] = [...new Set(h.events.map((e) => e.kind))].join(",");
}
const askEvents = (await historyOf(askRun.agentId)).events;
check("the Allow once run logged the request and its resolution", askEvents.some((e) => e.kind === "permission.request") && askEvents.some((e) => e.kind === "permission.resolved"), askEvents.map((e) => e.kind).join(","));
const pushEvents = (await historyOf(pushRun.agentId)).events;
const pushResolved = pushEvents.find((e) => e.kind === "permission.resolved");
const askResolved = askEvents.find((e) => e.kind === "permission.resolved");
check("the push was decided by the hard stop and denied, no user in between", pushResolved?.by === "hardStop" && /deny|reject/i.test(String(pushResolved?.outcome)), JSON.stringify(pushResolved));
check("the command was decided by the user", askResolved?.by === "user" && /allow/i.test(String(askResolved?.outcome)), JSON.stringify(askResolved));
await finish({ refused });
