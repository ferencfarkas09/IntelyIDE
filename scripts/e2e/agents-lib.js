// Helpers of the agent scenarios i, j and k (run.sh concatenates config.js, lib.js, this file and one scenario).
// They drive the REAL Agents dock through the DOM like a user.
const agentsPanel = () => q('[data-testid="chat-panel"]');
const runStatusText = () => text(q(".run-header__status"));
const panelText = () => text(agentsPanel());

async function openAgents() {
  if (!agentsPanel()) (await waitFor(() => findButton("Agents"), { what: "the Agents rail button" })).click();
  await waitFor(() => agentsPanel() && !q(".chat__loading", agentsPanel()), { what: "the agents dock", timeout: 30000 });
  await sleep(200);
}

/** New run opens in Auto (a lead and its delegates); a single-role run is one click away: "Run as role...". */
async function roleMode(pop) {
  await sleep(150);
  const asRole = qa("button", pop).find((b) => /^Run as role/.test(text(b)));
  if (asRole && !q(".newrun__role", pop)) asRole.click();
  await waitFor(() => q(".newrun__role", pop), { what: "the role list of New run" });
}

/** The permission mode cards of the New run dialog (data-mode: readOnly | ask | edit | automatic | bypass). */
const modeCard = (pop, mode) => q(`.mode-card[data-mode="${mode}"]`, pop);
const checkedMode = (pop) => qa(".mode-card", pop).find((c) => c.getAttribute("aria-checked") === "true")?.dataset.mode;
/** Picks a mode card (not Bypass: that one opens its confirmation) and waits until it is the checked one. */
async function pickMode(pop, mode) {
  const card = await waitFor(() => modeCard(pop, mode), { what: `the ${mode} mode card` });
  if (card.getAttribute("aria-checked") !== "true") card.click();
  await waitFor(() => card.getAttribute("aria-checked") === "true", { what: `mode ${mode} picked` });
}

/**
 * Opens "New run", picks the role and repos (by repo name), the mode, types the prompt and starts; waits for the run header.
 * The dialog now opens in Automatic, so a scenario that wants the old behaviour (a card for every call that asks) names the mode:
 * by default the role's own permission, which is what a run of that role used to start in.
 */
async function newRun(role, repoNames, prompt, { mode } = {}) {
  await clickButton("New run", agentsPanel());
  const pop = await waitFor(() => q(".newrun"), { what: "the New run popover" });
  await roleMode(pop);
  const radio = await waitFor(() => qa('[role="radio"]', pop).find((b) => text(b).startsWith(role)), { what: `role ${role}` });
  radio.click();
  await waitFor(() => radio.getAttribute("aria-checked") === "true", { what: `role ${role} picked` });
  await sleep(150);
  const own = (await invoke("agent_roles")).find((r) => r.name === role)?.permission ?? "ask";
  await pickMode(pop, mode ?? own);
  for (const b of qa('[aria-label="Repositories"] button', pop)) {
    const want = repoNames.some((n) => text(b).includes(n));
    if ((b.getAttribute("aria-pressed") === "true") !== want) b.click();
  }
  await sleep(100);
  await typeInto(q('textarea[aria-label="Prompt"]', pop), prompt);
  await clickButton("Start run", pop);
  await waitFor(() => q(".run-header"), { what: "the run header after Start", timeout: 60000 });
}

const permissionCard = () => q('section[aria-label="Permission request"]');
const settled = () => /^(Done|Failed)$/.test(runStatusText());

/** Waits for the run to end; denies every ordinary permission request on the way (nothing else may run). */
async function untilSettled({ timeout = 150000, denied = [] } = {}) {
  const t0 = performance.now();
  for (;;) {
    const card = permissionCard();
    if (card) {
      denied.push(text(card).slice(0, 160));
      findButton("Deny", card)?.click();
      await sleep(300);
    } else if (settled()) {
      await sleep(400);
      if (settled() && !permissionCard()) return;
    }
    if (performance.now() - t0 > timeout) throw new Error(`the run did not settle in ${timeout} ms; status "${runStatusText()}"; panel: ${panelText().slice(0, 600)}`);
    await sleep(250);
  }
}

/** Events of a run from the Rust log, checked for the stream invariants (seq +1, tool and turn pairing). */
async function historyOf(agentId) {
  const events = await invoke("agent_history", { agentId, afterSeq: null });
  const problems = [];
  let last = 0;
  const tools = new Set();
  let turns = 0;
  let open = false;
  for (const e of events) {
    if (e.seq !== last + 1) problems.push(`seq ${last} -> ${e.seq}`);
    last = e.seq;
    if (e.kind === "tool.start") tools.add(e.toolId);
    if (e.kind === "tool.result") tools.delete(e.toolId);
    if (e.kind === "user.message") open = true;
    if (e.kind === "turn.end") { turns++; open = false; }
  }
  if (tools.size) problems.push(`unclosed tools ${[...tools]}`);
  if (open) problems.push("turn never ended");
  return { events, problems, turns };
}

/** A real-window screenshot (WKWebView snapshot) into INTELY_E2E_SHOTS; never fails the scenario. */
async function shot(name) {
  try {
    (notes.shots ??= []).push(await window.__e2e.screenshot(name));
  } catch (e) {
    (notes.shotErrors ??= []).push(String(e?.message ?? e));
  }
}
