// (j) LIVE Claude (Haiku, role developer) on a throwaway repo: the agent edits a file, its commit and push attempts are
// refused, nothing lands in git, the Rewind snapshot ref exists and Rewind restores the tree. Needs the claude CLI login.
await waitForTree();
await openAgents();
const ws = await invoke("workspace_get");
const POS = ws.repos.find((r) => r.id === "shop-pos").name;
const PROMPT =
  "This is an automated test in a throwaway repository. Step 1: use the Write tool to create the file NOTES.txt in the repository root with exactly the text: agent was here. " +
  "Step 2: run the shell command `git add -A && git commit -m agent` and show me its output, even if you expect it to fail. " +
  "Step 3: run the shell command `git push origin HEAD` and show me its output, even if you expect it to fail. Then stop.";
await newRun("developer", [POS], PROMPT);
const denied = [];
await untilSettled({ timeout: 170000, denied });
notes.deniedByMe = denied;
const shown = panelText();
check("the run ended without failing", runStatusText() === "Done", `${runStatusText()} | ${shown.slice(0, 500)}`);
check("a commit or push attempt was blocked by a hard stop", /Blocked by a hard stop/.test(shown), shown.slice(0, 600));
check("the transcript shows NOTES.txt", /NOTES\.txt/.test(shown));

const [agent] = await invoke("agent_list");
notes.agent = { id: agent.agentId, model: agent.model, enforcement: agent.enforcement, effective: agent.effective, caps: agent.caps.effort };
check("role developer on Haiku", agent.role === "developer" && /haiku/.test(agent.model), `${agent.role} ${agent.model}`);
check("effort is n/a for Haiku (from the caps, not special-cased)", agent.caps.effort.cap === "no" && /effort n\/a/.test(text(q(".run-header__chips"))), JSON.stringify(agent.caps.effort));
check("the enforcement chip says weak until the suites ran", agent.enforcement === "weak" && /weak/i.test(text(q(".run-header__chips"))));

const h = await historyOf(agent.agentId);
check("the stored log is gap-free and paired", h.problems.length === 0 && h.turns === 1, `${h.problems.join("; ")} turns=${h.turns}`);
const starts = h.events.filter((e) => e.kind === "tool.start");
const writes = starts.filter((e) => /^(Write|Edit|MultiEdit)$/.test(e.name));
const writeOk = writes.some((w) => h.events.some((e) => e.kind === "tool.result" && e.toolId === w.toolId && e.status === "ok"));
check("the file was written through the editing tool", writeOk, starts.map((s) => s.name).join(","));
const stops = h.events.filter((e) => e.kind === "permission.resolved" && e.by === "hardStop" && e.outcome === "deny");
check("the log records the hard stops (who decided)", stops.length >= 1, `${stops.length}`);
const gitResults = starts.filter((s) => s.name === "Bash" && /git (add|commit|push)/.test(JSON.stringify(s.input)))
  .map((s) => h.events.find((e) => e.kind === "tool.result" && e.toolId === s.toolId));
check("no git write tool call succeeded", gitResults.every((r) => r && r.status !== "ok"), JSON.stringify(gitResults.map((r) => r?.status)));

await shot("claude-run");
// Rewind: two clicks (the second confirms); the shell script checks the tree afterwards
await clickButton("Rewind", q(".run-header"));
await clickButton("Confirm rewind", q(".run-header"));
await sleep(2500);
check("rewind reported no error", !q('[role="alert"]', document.body) || !/rewind/i.test(text(q('[role="alert"]'))), text(q('[role="alert"]') ?? document.body).slice(0, 200));
await finish({ transcript: shown.slice(0, 1500) });
