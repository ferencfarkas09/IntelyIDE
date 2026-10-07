// (k) Fail closed with a damaged policy channel (INTELY_E2E_POLICY_FAULT, run.sh sets it per variant): the host does not
// answer `policy/decide` (drop) or closes the pipe at the first request (close). The Write call must be denied, never run.
await waitForTree();
await openAgents();
const ws = await invoke("workspace_get");
const POS = ws.repos.find((r) => r.id === "shop-pos").name;
const MODE = typeof FAULT === "string" ? FAULT : "drop";
await newRun("developer", [POS], "This is an automated test in a throwaway repository. Use the Write tool to create the file PROOF.txt in the repository root containing exactly: proof. Then stop.");
const denied = [];
await untilSettled({ timeout: 120000, denied });
await shot("fail-closed");
const shown = panelText();
const [agent] = await invoke("agent_list");
const h = await historyOf(agent.agentId);
const resolved = h.events.filter((e) => e.kind === "permission.resolved");
const writeStarts = h.events.filter((e) => e.kind === "tool.start" && /^(Write|Edit|MultiEdit)$/.test(e.name));
const writeRan = writeStarts.some((w) => h.events.some((e) => e.kind === "tool.result" && e.toolId === w.toolId && e.status === "ok"));
notes.fault = MODE;
notes.resolved = resolved.map((e) => `${e.outcome}/${e.by}`);
check("the Write call never ran", !writeRan, JSON.stringify(writeStarts.map((w) => w.name)));
if (MODE === "drop") {
  check("every unanswered policy request was denied by failClosed", resolved.length >= 1 && resolved.every((e) => e.outcome === "deny" && e.by === "failClosed"), notes.resolved.join(","));
  check("the card says the policy check was unavailable", /policy check was unavailable/.test(shown), shown.slice(0, 500));
} else {
  // the sidecar sees EOF while the request is open: it denies, stops its sessions (cancelled) and exits; nothing runs
  const end = h.events.filter((e) => e.kind === "turn.end").at(-1);
  check("the turn ended without the call running (cancelled or error)", ["cancelled", "error"].includes(end?.stopReason), JSON.stringify(end));
  const results = writeStarts.map((w) => h.events.find((e) => e.kind === "tool.result" && e.toolId === w.toolId)?.status);
  check("the Write call was cancelled or denied, never ok", results.length > 0 && results.every((r) => r === "cancelled" || r === "denied"), JSON.stringify(results));
  check("pending requests were cancelled or denied, none allowed", resolved.every((e) => e.outcome !== "allow"), notes.resolved.join(","));
}
check("the stored log is gap-free and paired", h.problems.length === 0, h.problems.join("; "));
await finish({ transcript: shown.slice(0, 1200) });
