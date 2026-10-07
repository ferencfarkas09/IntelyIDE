// (jd) LIVE Claude (Haiku, role developer) in BYPASS mode (the confirmation is accepted like pm-modes.js does): no permission card ever, a shell heredoc whose
// body has braces with quotes, a regex with <1-5> and `$(date)` text, node runs it, `find`, a read of the PARENT folder of the repo, and finally
// `git add -A && git commit` and `git push`, which the hard stops must refuse even in Bypass. The run ends Done and git is untouched.
await waitForTree();
await openAgents();
const ws = await invoke("workspace_get");
const POS = ws.repos.find((r) => r.id === "shop-pos").name;
const PROMPT =
  "This is an automated test in a throwaway repository. Do these steps in order with the shell (Bash) tool, one command each, and show each output.\n" +
  "1. Write the file gen.js through a shell heredoc with a QUOTED delimiter: cat > gen.js <<'EOF' ... EOF. The body is exactly these three lines:\n" +
  "const cfg = { a: \"x\", b: 'y', c: { d: [1, 2] } };\n" +
  "const re = /<1-5>/; // range <1-5> and the literal text $(date)\n" +
  "console.log(\"RESULT=\" + (6 * 7), re.test(\"<1-5>\"), \"$(date)\");\n" +
  "2. Run: node gen.js\n" +
  "3. Run: find . -name \"*.js\" | head\n" +
  "4. Run: ls ..   (the parent folder of the repository)\n" +
  "5. Run: git add -A && git commit -m x   (show the output even if it is refused)\n" +
  "6. Run: git push   (show the output even if it is refused)\n" +
  "Then stop and tell me which steps worked.";
await newRoleRun("developer", [POS], PROMPT, "bypass");
check("the header shows the BYPASS chip", /Bypass/.test(chipLabel()) && qa('.run-header [role="status"]', agentsPanel()).some((e) => text(e) === "BYPASS"), chipLabel());
const denied = [];
await untilSettled({ timeout: 250000, denied });
notes.deniedByMe = denied;
const shown = panelText();
check("the run ended Done", runStatusText() === "Done", `${runStatusText()} | ${shown.slice(0, 500)}`);
check("Bypass asked nothing: no permission card ever showed", denied.length === 0, denied.join(" || "));
const gen = await readRepoFile("gen.js");
check("gen.js has the exact heredoc body (braces, quotes, <1-5>, $(date))", /const cfg = \{ a: "x", b: 'y', c: \{ d: \[1, 2\] \} \};/.test(gen ?? "") && /<1-5>/.test(gen ?? "") && /\$\(date\)/.test(gen ?? "") && /"RESULT=" \+ \(6 \* 7\)/.test(gen ?? ""), JSON.stringify(gen));
const run = await latestRun();
const h = await historyOf(run.agentId);
check("the stored log is gap-free and paired", h.problems.length === 0, h.problems.join("; "));
const calls = toolInputs(h.events).filter((s) => s.name === "Bash");
notes.bash = calls.map((c) => `${c.ok ? "ok" : "no"}: ${JSON.stringify(c.input).slice(0, 90)}`);
const heredoc = calls.find((c) => /<<\s*['"]?EOF/.test(JSON.stringify(c.input)) || /<<\\?'?EOF/.test(JSON.stringify(c.input)));
check("the heredoc step ran and succeeded", !!heredoc && heredoc.ok, JSON.stringify(heredoc ?? null).slice(0, 200));
const nodeStep = calls.find((c) => /node gen\.js/.test(JSON.stringify(c.input)));
check("`node gen.js` succeeded and printed RESULT=42", !!nodeStep && nodeStep.ok && /RESULT=42/.test(shown), `${nodeStep?.ok} / ${shown.slice(0, 300)}`);
const findStep = calls.find((c) => /find \./.test(JSON.stringify(c.input)));
check("`find . -name \"*.js\"` succeeded", !!findStep && findStep.ok, JSON.stringify(findStep ?? null).slice(0, 200));
const lsStep = calls.find((c) => /ls \.\./.test(JSON.stringify(c.input)));
check("`ls ..` (the parent folder) succeeded", !!lsStep && lsStep.ok, JSON.stringify(lsStep ?? null).slice(0, 200));
const stops = h.events.filter((e) => e.kind === "permission.resolved" && e.by === "hardStop");
notes.perm = permLines(h.events);
check("no permission was left to the user (every request was answered by a hard stop)", askedUser(h.events).length === 0, notes.perm.join(" ## ").slice(0, 400));
const commitStep = calls.find((c) => /git add -A && git commit/.test(JSON.stringify(c.input)));
const pushStep = calls.find((c) => /git push/.test(JSON.stringify(c.input)));
check("the commit attempt did not succeed", !commitStep || !commitStep.ok, JSON.stringify(commitStep ?? null).slice(0, 200));
check("the push attempt did not succeed", !pushStep || !pushStep.ok, JSON.stringify(pushStep ?? null).slice(0, 200));
check("both git writes were blocked by a hard stop (by hardStop)", stops.length >= 2, `${stops.length}: ${notes.perm.join(" ## ").slice(0, 500)}`);
await shot("bypass-live-run");
await finish({ transcript: shown.slice(0, 2000) });
