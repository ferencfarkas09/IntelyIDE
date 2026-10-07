// (jb) LIVE Claude, DEFAULT models (no override): the Auto lead delegates to the roles. A researcher reads package.json, a developer writes the
// file, the lead runs `git status`. Automatic mode: not a single permission card, the sub-agents' calls are attributed (nested under the Agent
// call), the run ends Done and git stays exactly as it was. The repo's own .claude/settings.local.json is hostile (allow all, bypassPermissions).
// Needs the claude CLI login; costs a few cents of real model time (cap INTELY_AGENT_MAX_BUDGET_USD in run.sh).
await waitForTree();
await openAgents();
const ws = await invoke("workspace_get");
const POS = ws.repos.find((r) => r.id === "shop-pos").name;
const PROMPT =
  "This is an automated test in a throwaway repository. Do it with your roles: first the researcher role reads package.json in the repository root and reports the value of its \"name\" field; " +
  "then the developer role creates the file DELEGATED.txt in the repository root with exactly the text: delegated by the lead. " +
  "Finally run the shell command `git status --short` yourself and show me its output. Do not commit, stage or push anything. Then stop.";

await clickButton("New run", agentsPanel());
const pop = await waitFor(() => q(".newrun"), { what: "the New run popover" });
await waitFor(() => qa(".mode-card", pop).length > 0, { what: "the mode cards of New run", timeout: 30000 });
check("New run opens in Auto with Automatic checked", !q(".newrun__role", pop) && checkedMode(pop) === "automatic", `${q(".newrun__role", pop) ? "role list" : "auto"} / ${checkedMode(pop)}`);
for (const b of qa('[aria-label="Repositories"] button', pop)) {
  const want = text(b).includes(POS);
  if ((b.getAttribute("aria-pressed") === "true") !== want) b.click();
}
await sleep(100);
await typeInto(q('textarea[aria-label="Prompt"]', pop), PROMPT);
await clickButton("Start run", pop);
await waitFor(() => q(".run-header"), { what: "the run header after Start", timeout: 60000 });

const denied = [];
await untilSettled({ timeout: 250000, denied });
notes.deniedByMe = denied;
const shown = panelText();
check("the run ended Done", runStatusText() === "Done", `${runStatusText()} | ${shown.slice(0, 500)}`);
check("Automatic asked nothing: no permission card ever showed", denied.length === 0, denied.join(" || "));
check("the header names the Automatic mode", /Automatic/i.test(text(q(".run-header"))), text(q(".run-header")).slice(0, 200));

const written = await invoke("files_read_file", { repoId: "shop-pos", relPath: "DELEGATED.txt" }).catch(() => null);
check("DELEGATED.txt was written with the asked text", /delegated by the lead/.test(written?.text ?? ""), JSON.stringify(written?.text ?? null));

const [agent] = await invoke("agent_list");
notes.agent = { id: agent.agentId, role: agent.role, model: agent.model, enforcement: agent.enforcement, effective: agent.effective };
const h = await historyOf(agent.agentId);
check("the stored log is gap-free and paired", h.problems.length === 0, h.problems.join("; "));
const starts = h.events.filter((e) => e.kind === "tool.start");
notes.tools = starts.map((s) => `${s.parentToolId ? "sub" : "lead"}:${s.name}`);
const okResult = (s) => h.events.some((e) => e.kind === "tool.result" && e.toolId === s.toolId && e.status === "ok");
const delegations = starts.filter((s) => /^(Agent|Task)$/.test(s.name));
check("the lead delegated (an Agent/Task call)", delegations.length >= 1, notes.tools.join(","));
check("the sub-agents' own calls are nested under the delegation", starts.some((s) => !!s.parentToolId), notes.tools.join(","));
check("the file was written by a succeeded tool call", starts.some((s) => /^(Write|Edit|MultiEdit|Bash)$/.test(s.name) && okResult(s)), notes.tools.join(","));
check("`git status` ran through the shell tool", starts.some((s) => s.name === "Bash" && /git status/.test(JSON.stringify(s.input)) && okResult(s)), starts.map((s) => `${s.name}:${JSON.stringify(s.input).slice(0, 60)}`).join(" | "));
check("no permission request was raised and no hard stop was needed", !h.events.some((e) => e.kind === "permission.request") && !h.events.some((e) => e.kind === "permission.resolved" && e.by === "hardStop"),
  h.events.filter((e) => /^permission\./.test(e.kind)).map((e) => `${e.kind}:${e.by ?? ""}:${e.outcome ?? ""}`).join(","));

await shot("auto-delegate-run");
await finish({ transcript: shown.slice(0, 2000) });
