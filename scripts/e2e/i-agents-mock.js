// (i) The mock provider through the real chain: sidecar process, protocol, policy broker, event log, dock UI.
// Six runs: streamed reply, Allow once, Deny, Interrupt, provider error, hard stop. Needs INTELY_MOCK_PROVIDER=1.
await waitForTree();
await openAgents();
const ws = await invoke("workspace_get");
const nameOf = (id) => ws.repos.find((r) => r.id === id).name;
const [BACKEND, ADMIN, SERVICES, POS] = FX.repoIds.map(nameOf);
const roles = await invoke("agent_roles");
check("the New run list offers the mock roles", roles.some((r) => r.name === "mock-tool-permission") && roles.some((r) => r.provider === "claude"), roles.map((r) => r.name).join(","));

// 1. streamed reply
await newRun("mock-plain-reply", [BACKEND], "say hello");
await waitFor(() => /Hello from the mock provider/.test(panelText()), { what: "the streamed text", timeout: 30000 });
await waitFor(() => runStatusText() === "Done", { what: "status Done", timeout: 30000 });
check("1 plain reply: streamed text, thinking block and Done", /mock provider/.test(panelText()) && runStatusText() === "Done", panelText().slice(0, 300));

// 2. Allow once
await newRun("mock-tool-permission", [BACKEND], "write a note");
const card1 = await waitFor(permissionCard, { what: "the permission card", timeout: 30000 });
check("2 permission card names the call and the run needs me", /notes\.txt/.test(text(card1)) && runStatusText() === "Needs you", `${text(card1)} / ${runStatusText()}`);
await shot("permission-card");
check("2 the new request takes focus (primary button)", await waitFor(() => card1.contains(document.activeElement), { what: "focus in the permission card", timeout: 3000 }).then(() => true, () => false), String(document.activeElement && document.activeElement.outerHTML.slice(0, 120)));
check("2 only the offered choices are rendered", !findButton("Always for role + repo", card1) && !!findButton("Deny", card1), text(card1));
findButton("Allow once", card1).click();
check("2 after the answer focus lands on the composer, not on the page body", await waitFor(() => q(".composer textarea") === document.activeElement, { what: "focus on the composer", timeout: 3000 }).then(() => true, () => false), String(document.activeElement && document.activeElement.tagName));
await waitFor(() => /Done: notes\.txt written/.test(panelText()), { what: "the text after Allow once", timeout: 30000 });
await waitFor(() => runStatusText() === "Done", { what: "Done after Allow once" });
check("2 Allow once lets the call through", /Allowed once by you/.test(panelText()), panelText().slice(0, 400));

// 3. Deny, in another repo (the finished run above gives its slot back if needed)
await newRun("mock-tool-permission", [ADMIN], "write a note");
const card2 = await waitFor(permissionCard, { what: "the second permission card", timeout: 30000 });
findButton("Deny", card2).click();
await waitFor(() => /I did not write the file/.test(panelText()), { what: "the text after Deny", timeout: 30000 });
await waitFor(() => runStatusText() === "Done", { what: "Done after Deny" });
check("3 Deny refuses the call", /Denied by you/.test(panelText()), panelText().slice(0, 400));

// 4. Interrupt
await newRun("mock-interrupt", [SERVICES], "run for a long time");
await waitFor(() => /sleep 30|Bash/.test(panelText()), { what: "the running tool", timeout: 30000 });
await clickButton("Interrupt", agentsPanel());
await waitFor(() => /You stopped this turn/.test(panelText()), { what: "the stop marker", timeout: 20000 });
await waitFor(() => runStatusText() === "Done", { what: "Done after Interrupt" });
check("4 Interrupt ends the turn as stopped", /You stopped this turn/.test(panelText()));

// 5. provider error
await newRun("mock-error", [POS], "fail please");
const banner = await waitFor(() => q('[role="alert"].banner', agentsPanel()), { what: "the error banner", timeout: 30000 });
check("5 error banner explains the failure", /provider reported an error/i.test(text(banner)) && /upstream returned 500/.test(text(banner)), text(banner));
await waitFor(() => runStatusText() === "Failed", { what: "status Failed" });
await shot("error-banner");

// 6. hard stop
await newRun("mock-hard-stop", [BACKEND], "push it");
await waitFor(() => /Blocked by a hard stop/.test(panelText()), { what: "the hard stop line", timeout: 30000 });
await waitFor(() => runStatusText() === "Done", { what: "Done after the hard stop" });
check("6 a hard stop is shown as blocked, without asking", /Blocked by a hard stop/.test(panelText()) && !permissionCard());

// the run list and the stored logs
await clickButton("Runs", agentsPanel());
await sleep(400);
await shot("run-list");
await waitFor(() => qa('[role="treeitem"], [role="row"]', agentsPanel()).length >= 6 || /Done/.test(panelText()), { what: "the run list" });
const list = await invoke("agent_list");
check("agent_list knows all six runs", list.length === 6, `${list.length}`);
const states = list.map((a) => `${a.role}:${a.status}`).sort().join(" ");
notes.states = states;
check("statuses: five done, one failed", list.filter((a) => a.status === "done").length === 5 && list.filter((a) => a.status === "error").length === 1, states);
for (const a of list) {
  const h = await historyOf(a.agentId);
  check(`log of ${a.role}: gap-free, tools and turns paired`, h.problems.length === 0 && h.turns >= 1, `${h.problems.join("; ")} turns=${h.turns}`);
  check(`${a.role}: run header data (caps, enforcement, requested)`, !!a.caps && a.enforcement === "weak" && !!a.requested, JSON.stringify([a.enforcement, a.requested]));
}
// forged and repeated answers are refused by the host
const perm = list.find((a) => a.role === "mock-tool-permission");
const forged = await invoke("agent_answer_permission", { agentId: perm.agentId, requestId: "forged", decision: "allowOnce" }).then(() => "accepted", (e) => e.code);
check("an answer to a request that is not pending is refused", forged === "unknownRequest" || forged === "notRunning", forged);
await finish({ states });
