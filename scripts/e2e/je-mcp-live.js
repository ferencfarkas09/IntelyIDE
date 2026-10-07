// (je) LIVE Claude (Haiku, role developer) with a stdio MCP server: scripts/mcp-fixture/mcp-fixture-server.mjs is added through Settings > MCP servers (the same UI path as
// the mcs scenario: Add server, Save and test, Confirm and test), with the rules echo = Allow and write_note = Ask. Then three runs that call the `echo` tool:
// (1) Ask mode, (2) Bypass, (3) Automatic. The outcome of (3) is recorded and must be explained in the transcript (no silent failure). Finally `/mcp` is typed into
// the composer and what the UI does is recorded (not asserted). Needs the claude CLI login.
await waitForTree();
const SERVER_SCRIPT = FX.mcpFixture;
const NAME = "fx";
const dialogOf = (title) => qa('[role="dialog"], [role="alertdialog"]').find((d) => text(q("h2", d)) === title);
const rowOf = (name) => qa(".mcp-row").find((r) => text(q(".mcp-name", r)) === name);
const fieldByLabel = (root, label) => qa("input, textarea", root).find((i) => i.id && text(q(`label[for="${i.id}"]`, root)) === label);
async function setSelect(el, value) { el.value = value; el.dispatchEvent(new Event("change", { bubbles: true })); await sleep(200); }

step("add the fixture server in Settings");
await press(",", { meta: true });
const settings = await waitFor(() => q(".settings"), { what: "Settings" });
(await waitFor(() => qa(".settings__item", settings).find((b) => /^MCP servers$/.test(text(b))), { what: "the MCP servers section" })).click();
await waitFor(() => q(".mcp") && !q(".mcp__loading"), { what: "the MCP section to load", timeout: 20000 });
await sleep(400);
const pane = () => q(".settings__pane");
await clickButton("Add server", pane());
const editor = await waitFor(() => dialogOf("Add MCP server"), { what: "the editor" });
await typeInto(fieldByLabel(editor, "Name"), NAME);
await typeInto(fieldByLabel(editor, "Command"), "node");
await typeInto(fieldByLabel(editor, "Arguments"), SERVER_SCRIPT);
await clickButton("Save and test", editor);
await clickButton("Confirm and test", await waitFor(() => dialogOf("Run this program?"), { what: "the confirm dialog" }));
const row = await waitFor(() => rowOf(NAME), { what: `the row of ${NAME}` });
await waitFor(() => q(".mcp-test__ok", row), { what: "the Test result", timeout: 30000 });
const toolRow = (tool) => qa("tr[data-tool]", row).find((r) => r.getAttribute("data-tool") === tool);
await waitFor(() => toolRow("echo") && toolRow("write_note"), { what: "the fixture tools", timeout: 15000 });
await setSelect(q('select[aria-label="Rule for echo"]', row), "allow");
await waitFor(() => q('select[aria-label="Rule for echo"]', row)?.value === "allow", { what: "echo = Allow" });
await setSelect(q('select[aria-label="Rule for write_note"]', row), "ask");
await waitFor(() => q('select[aria-label="Rule for write_note"]', row)?.value === "ask", { what: "write_note = Ask" });
check("the server is Ready, On by default, with echo = Allow and write_note = Ask", /Ready/.test(text(row)) && q('select[aria-label="Rule for echo"]', row).value === "allow" && q('select[aria-label="Rule for write_note"]', row).value === "ask", text(row).slice(0, 200));
await press("Escape");
await waitFor(() => !q(".settings"), { what: "Settings to close" }).catch(() => {});
await sleep(300);

await openAgents();
const ws = await invoke("workspace_get");
const POS = ws.repos.find((r) => r.id === "shop-pos").name;
const PROMPT = (tok) => `This is an automated test. Call the MCP tool "echo" (from the MCP server named ${NAME}) with the text ${tok} and show me the result it returns. Use no other tool. Then stop.`;

/** Waits for the run to end; ALLOWS every card (recording it) when allow is true, else denies. */
async function settleRecording({ allow, timeout = 170000 }) {
  const cards = [];
  const t0 = performance.now();
  for (;;) {
    const card = permissionCard();
    if (card) {
      cards.push(text(card).slice(0, 220));
      findButton(allow ? "Allow once" : "Deny", card)?.click();
      await sleep(400);
    } else if (settled()) {
      await sleep(500);
      if (settled() && !permissionCard()) return cards;
    }
    if (performance.now() - t0 > timeout) throw new Error(`the run did not settle in ${timeout} ms; status "${runStatusText()}"; panel: ${panelText().slice(0, 500)}`);
    await sleep(250);
  }
}
const echoCalls = (h) => toolInputs(h.events).filter((s) => /echo/.test(s.name) && /mcp/i.test(s.name));
const resultOf = (h, call) => h.events.find((e) => e.kind === "tool.result" && e.toolId === call.toolId);

async function oneRun(label, mode, tok, allow) {
  step(label);
  await backToRuns();
  await newRoleRun("developer", [POS], PROMPT(tok), mode);
  const cards = await settleRecording({ allow });
  const run = await latestRun();
  const h = await historyOf(run.agentId);
  const calls = echoCalls(h);
  const res = calls.map((c) => resultOf(h, c));
  const out = { cards, shown: panelText(), h, calls, res, perm: permLines(h.events), mode: chipLabel(), runId: run.agentId };
  notes[label] = { cards, perm: out.perm, calls: calls.map((c) => `${c.name}:${c.ok ? "ok" : "no"}`), status: runStatusText(), tools: toolInputs(h.events).map((s) => `${s.name}:${s.ok ? "ok" : "no"}`) };
  await shot(label.replace(/\W+/g, "-"));
  return out;
}

// ---- (1) Ask ----------------------------------------------------------------------------------------------------------------------------------
const r1 = await oneRun("1 ask", "ask", "pong-7391", true);
check("1 ask: the run ended Done", runStatusText() === "Done", `${runStatusText()} | ${r1.shown.slice(0, 400)}`);
check("1 ask: the echo MCP tool was called", r1.calls.length >= 1, notes["1 ask"].tools.join(","));
check("1 ask: no ToolSearch card (the MCP tool needs no extra permission to load)", !r1.cards.some((c) => /ToolSearch/i.test(c)), r1.cards.join(" || "));
check("1 ask: the MCP chip shows in the run header", !!q(".run-header .mcp-chip", agentsPanel()) || !!q(".mcp-chip", agentsPanel()), text(q(".run-header", agentsPanel())).slice(0, 200));
check("1 ask: either the card names the MCP tool, or the Allow rule let it through without a card", r1.cards.length ? r1.cards.some((c) => /echo/i.test(c) && /fx|mcp/i.test(c)) : r1.perm.every((l) => !/request/.test(l)), r1.cards.join(" || ") || r1.perm.join(" ## "));
check("1 ask: the tool result pong-7391 is in the log", r1.res.some((e) => e && e.status === "ok" && /pong-7391/.test(JSON.stringify(e))), JSON.stringify(r1.res).slice(0, 300));
check("1 ask: the result is in the transcript", (r1.shown.match(/pong-7391/g) ?? []).length >= 2, r1.shown.slice(-400));
check("1 ask: the log is gap-free and paired", r1.h.problems.length === 0, r1.h.problems.join("; "));

// ---- (2) Bypass -------------------------------------------------------------------------------------------------------------------------------
const r2 = await oneRun("2 bypass", "bypass", "pong-4482", false);
check("2 bypass: the run ended Done", runStatusText() === "Done", `${runStatusText()} | ${r2.shown.slice(0, 400)}`);
check("2 bypass: no permission card", r2.cards.length === 0, r2.cards.join(" || "));
check("2 bypass: the tool result pong-4482 is in the log", r2.res.some((e) => e && e.status === "ok" && /pong-4482/.test(JSON.stringify(e))), JSON.stringify(r2.res).slice(0, 300) + " | " + notes["2 bypass"].tools.join(","));
check("2 bypass: the result is in the transcript", (r2.shown.match(/pong-4482/g) ?? []).length >= 2, r2.shown.slice(-400));

// ---- (3) Automatic: recorded, the outcome must be explained ----------------------------------------------------------------------------------------
const r3 = await oneRun("3 automatic", "automatic", "pong-9035", false);
check("3 automatic: the run ended (Done or Failed, never hung)", settled(), runStatusText());
const gotResult = r3.res.some((e) => e && e.status === "ok" && /pong-9035/.test(JSON.stringify(e)));
const explained = /den|refus|not allowed|blocked|could not|couldn't|cannot|unable|not available|no access|permission|declin/i.test(r3.shown.replace(PROMPT("pong-9035"), ""));
notes.automaticOutcome = { cards: r3.cards.length, gotResult, explained, perm: r3.perm, tools: notes["3 automatic"].tools };
check("3 automatic: no silent failure (the result is there, or the transcript says why not)", gotResult || explained, `${JSON.stringify(notes.automaticOutcome).slice(0, 500)} | ${r3.shown.slice(-400)}`);
check("3 automatic: no card was left open", !permissionCard(), "");

// ---- /mcp in the composer: recorded only ----------------------------------------------------------------------------------------------------------
step("/mcp in the composer");
const composer = qa("textarea", agentsPanel()).find((x) => !x.closest(".newrun"));
if (composer) {
  composer.focus();
  await typeInto(composer, "/mcp");
  await sleep(700);
  await typeInto(composer, "/");
  await sleep(700);
  const slash = q('[data-testid="slash-menu"]');
  notes.slashAll = slash ? text(slash).slice(0, 300) : null;
  check("typing / in the composer opens the slash menu listing /mcp, /agents and /mode", !!slash && /\/mcp/.test(text(slash)) && /\/agents/.test(text(slash)) && /\/mode/.test(text(slash)), String(notes.slashAll));
  await typeInto(composer, "/mcp");
  await sleep(700);
  notes.slashMcp = { menu: text(q('[data-testid="slash-menu"]') ?? document.body).slice(0, 200), composerValue: composer.value, toasts: qa(".ui-toast").map(text) };
  await shot("slash-mcp");
  await typeInto(composer, "");
} else {
  notes.slashMcp = "no composer found in the run view";
}
await finish({ transcript: r1.shown.slice(0, 600) });
