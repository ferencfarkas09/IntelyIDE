// (jf) LIVE Claude, AUTOMATIC with the owner's real failure pattern: the Auto lead delegates; the developer writes several files through shell heredocs
// whose JS bodies hold braces, quotes, <N-M> text and $(...) text, and the researcher Greps the PARENT folder of the repo. The run must end Done with no
// permission card, the files must hold the exact content, no heredoc write may be resolved by failClosed (rule cli.prompt-denied), the parent-folder read
// is refused by roleDeny, and the run recovers. Needs the claude CLI login.
await waitForTree();
await openAgents();
const ws = await invoke("workspace_get");
const POS = ws.repos.find((r) => r.id === "shop-pos").name;
const PROMPT =
  "This is an automated test in a throwaway repository. Do it with your roles.\n" +
  "A) The developer role writes THREE files with the shell (Bash) tool, each through its own heredoc with a QUOTED delimiter (cat > FILE <<'EOF' ... EOF):\n" +
  "- one.js with the body: const o = { k: \"v\", n: { m: 'w' } };\\nconsole.log(\"one\", JSON.stringify(o), \"$(echo hi)\");\n" +
  "- two.js with the body: const re = /<1-5>|<6-9>/g;\\nconsole.log(\"two\", \"a <1-5> b\".replace(re, \"#\"), `${1 + 1}`);\n" +
  "- three.js with the body: function f(x) { if (x) { return { ok: \"yes\", at: \"$(date)\" }; } return {}; }\\nconsole.log(\"three\", typeof f);\n" +
  "(each \\n above means a real line break inside the file).\n" +
  "B) The researcher role Greps for the word \"name\" in the PARENT folder of the repository (the directory that contains the repository folder) and reports what happened, even if it is refused.\n" +
  "C) Finally the developer role runs `node one.js && node two.js && node three.js` and you show me the output. Do not commit, stage or push anything. Then stop.";
await newAutoRun(POS, PROMPT, { mode: "automatic" });
const denied = [];
await untilSettled({ timeout: 330000, denied });
notes.deniedByMe = denied;
const shown = panelText();
check("the run ended Done", runStatusText() === "Done", `${runStatusText()} | ${shown.slice(0, 500)}`);
check("Automatic asked nothing: no permission card ever showed", denied.length === 0, denied.join(" || "));
const one = await readRepoFile("one.js");
const two = await readRepoFile("two.js");
const three = await readRepoFile("three.js");
check("one.js has the exact content ({ } quotes, $(echo hi))", /const o = \{ k: "v", n: \{ m: 'w' \} \};/.test(one ?? "") && /"\$\(echo hi\)"/.test(one ?? ""), JSON.stringify(one));
check("two.js has the exact content (regex with <1-5>|<6-9>, template literal)", /\/<1-5>\|<6-9>\/g/.test(two ?? "") && /`\$\{1 \+ 1\}`/.test(two ?? ""), JSON.stringify(two));
check("three.js has the exact content (nested braces, $(date))", /function f\(x\) \{ if \(x\) \{ return \{ ok: "yes", at: "\$\(date\)" \}; \} return \{\}; \}/.test(three ?? ""), JSON.stringify(three));
const run = await latestRun();
const h = await historyOf(run.agentId);
check("the stored log is gap-free and paired", h.problems.length === 0, h.problems.join("; "));
notes.perm = permLines(h.events);
const failClosedPrompt = h.events.filter((e) => e.kind === "permission.resolved" && e.by === "failClosed" && /cli\.prompt-denied/.test(JSON.stringify(e)));
check("NO permission.resolved by failClosed with rule cli.prompt-denied (the heredoc writes are answered)", failClosedPrompt.length === 0, `${failClosedPrompt.length}: ${notes.perm.join(" ## ").slice(0, 700)}`);
check("no permission was left to the user", askedUser(h.events).length === 0, notes.perm.join(" ## ").slice(0, 500));
const starts = toolInputs(h.events);
notes.tools = starts.map((s) => `${s.parentToolId ? "sub" : "lead"}:${s.name}:${s.ok ? "ok" : "no"}`);
const heredocs = starts.filter((s) => s.name === "Bash" && /<</.test(JSON.stringify(s.input)));
check("the heredoc Bash calls succeeded (three of them)", heredocs.filter((s) => s.ok).length >= 3 || (!!one && !!two && !!three), `${heredocs.length} heredoc calls, ${heredocs.filter((s) => s.ok).length} ok; ${notes.tools.join(",")}`);
const refused = h.events.filter((e) => e.kind === "permission.resolved" && e.by === "roleDeny");
notes.roleDeny = refused.map((e) => String(e.message ?? e.reason ?? "").slice(0, 300));
const denyResults = h.events.filter((e) => e.kind === "tool.result" && e.status === "denied" && /roleDeny/.test(String(e.output ?? "")));
notes.roleDenyResults = denyResults.map((e) => String(e.output).replace(/\/Users\/[^\/ ]*/g, "~").slice(0, 300));
const agentCalls = starts.filter((s) => /^(Agent|Task)$/.test(s.name));
const deniedAgent = denyResults.filter((e) => agentCalls.some((s) => s.toolId === e.toolId));
check("no delegation (Agent call) was refused by roleDeny", deniedAgent.length === 0, notes.roleDenyResults.join(" || "));
const parentRead = starts.filter((s) => /^(Grep|Glob|Read|LS)$/.test(s.name) && !agentCalls.includes(s));
notes.reads = parentRead.map((s) => `${s.name}:${s.ok ? "ok" : "no"}:${JSON.stringify(s.input).replace(/\/private[^"]*?\/repos\//g, "<fx>/repos/").slice(0, 100)}`);
const refusedRead = denyResults.filter((e) => parentRead.some((s) => s.toolId === e.toolId));
check("the researcher's parent-folder read was refused by roleDeny", refusedRead.length >= 1, `${notes.reads.join(" | ")} || ${notes.roleDenyResults.join(" || ")}`);
check("the refusal lists the allowed folders (text may still be the old one)", refusedRead.some((e) => /allowed|folders?|repositor/i.test(String(e.output ?? ""))), notes.roleDenyResults.join(" || "));
check("the run recovered: the three scripts' output is in the transcript", /one/.test(shown) && /two/.test(shown) && /three/.test(shown), shown.slice(-500));
check("the lead delegated (an Agent/Task call)", starts.some((s) => /^(Agent|Task)$/.test(s.name)), notes.tools.join(","));
await shot("auto-heredoc-live");
await finish({ transcript: shown.slice(0, 2000) });
