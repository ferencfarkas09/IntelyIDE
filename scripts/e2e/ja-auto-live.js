// (ja) LIVE Claude through the Auto lead: what "New run" starts by default (Automatic mode, a lead that delegates to the roles) on a
// throwaway repo whose own .claude/settings.local.json is hostile (allow everything, bypassPermissions). The run must write a file and
// run a shell command WITHOUT a single permission card, end Done, and leave git exactly as it was. Needs the claude CLI login.
await waitForTree();
await openAgents();
const ws = await invoke("workspace_get");
const POS = ws.repos.find((r) => r.id === "shop-pos").name;
const PROMPT =
  "This is an automated test in a throwaway repository. Create the file AUTO.txt in the repository root with exactly the text: auto was here. " +
  "Then run the shell command `git status --short` and show me its output. Do not commit, stage or push anything. Then stop.";

// New run opens in Auto: no role is picked, only the repository and the prompt.
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
await untilSettled({ timeout: 200000, denied });
notes.deniedByMe = denied;
const shown = panelText();
check("the run ended Done", runStatusText() === "Done", `${runStatusText()} | ${shown.slice(0, 500)}`);
check("Automatic asked nothing: no permission card ever showed", denied.length === 0, denied.join(" || "));
check("the transcript shows AUTO.txt", /AUTO\.txt/.test(shown), shown.slice(0, 400));
check("the header names the Automatic mode", /Automatic/i.test(text(q(".run-header"))), text(q(".run-header")).slice(0, 200));

const written = await invoke("files_read_file", { repoId: "shop-pos", relPath: "AUTO.txt" }).catch(() => null);
check("AUTO.txt was written with the asked text", /auto was here/.test(written?.text ?? ""), JSON.stringify(written?.text ?? null));

const [agent] = await invoke("agent_list");
notes.agent = { id: agent.agentId, role: agent.role, model: agent.model, enforcement: agent.enforcement, effective: agent.effective };
const h = await historyOf(agent.agentId);
check("the stored log is gap-free and paired", h.problems.length === 0, h.problems.join("; "));
const starts = h.events.filter((e) => e.kind === "tool.start");
notes.tools = starts.map((s) => `${s.actor ?? "?"}:${s.name}`);
const okResult = (s) => h.events.some((e) => e.kind === "tool.result" && e.toolId === s.toolId && e.status === "ok");
check("a file-writing tool call succeeded", starts.some((s) => /^(Write|Edit|MultiEdit|Bash)$/.test(s.name) && okResult(s)), starts.map((s) => s.name).join(","));
check("`git status` ran through the shell tool", starts.some((s) => s.name === "Bash" && /git status/.test(JSON.stringify(s.input)) && okResult(s)), starts.map((s) => `${s.name}:${JSON.stringify(s.input).slice(0, 60)}`).join(" | "));
check("no permission request was raised and no hard stop was needed", !h.events.some((e) => e.kind === "permission.request") && !h.events.some((e) => e.kind === "permission.resolved" && e.by === "hardStop"),
  h.events.filter((e) => /^permission\./.test(e.kind)).map((e) => `${e.kind}:${e.by ?? ""}:${e.outcome ?? ""}`).join(","));
check("no sub-agent call is attributed to an unknown actor (?)", !starts.some((s) => s.actor === "?"), (notes.tools ?? []).join(","));

await shot("auto-live-run");
await finish({ transcript: shown.slice(0, 1500) });
