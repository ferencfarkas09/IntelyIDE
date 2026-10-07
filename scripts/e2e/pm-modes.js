// (pm, pm2) Permission modes through the real chain with the mock provider: sidecar process, protocol, policy broker, event log, dock UI.
// pm : the New run mode selector, the Bypass confirmation, an Automatic run that asks nothing, the session allow, the header chip (live
//      switch, the BYPASS chip), the Plan approval card (approve with a mode, reject with a note), a card withdrawn by a switch to Plan.
// pm2: the same app started with INTELY_NO_UNATTENDED=1 (the kill switch): the dialog offers no Automatic and no Bypass.
// Needs INTELY_MOCK_PROVIDER=1 and the built-in mock roles of the host: mock-interrupt, mock-plan-approval, mock-bash-twice
// (the host adds the last two to MOCK_SCENARIOS; bash-twice runs the same `Bash` command twice through the real broker).
await waitForTree();
await openAgents();
const ws = await invoke("workspace_get");
const nameOf = (id) => ws.repos.find((r) => r.id === id).name;
const [BACKEND, ADMIN, SERVICES, POS] = FX.repoIds.map(nameOf);
const roles = await invoke("agent_roles");
const haveRole = (name) => roles.some((r) => r.name === name);
for (const name of ["mock-interrupt", "mock-plan-approval", "mock-bash-twice"]) check(`the mock role ${name} is offered`, haveRole(name), roles.map((r) => r.name).join(","));

// ---- helpers --------------------------------------------------------------------------------------------------------------------------------------
/** The current UI state in dark and in light with the app's own screenshot (never a desktop capture); ends on the theme it started in. */
async function shotBoth(name) {
  const before = document.documentElement.getAttribute("data-theme") || "light";
  for (const theme of ["dark", "light"]) {
    document.documentElement.setAttribute("data-theme", theme);
    await sleep(700); // the colour transitions of the switch must have finished
    await shot(name);
  }
  document.documentElement.setAttribute("data-theme", before);
  await sleep(300);
}
const cardsOf = (pop) => qa(".mode-card", pop).map((c) => c.dataset.mode);
const mark = (pop) => qa(".mode-card", pop).map((c) => `${c.dataset.mode}:${c.getAttribute("aria-checked")}`).join(" ");
const confirmDialog = () => qa('[role="alertdialog"]').find((d) => /Switch on Bypass\?/.test(text(d)));
const permCard = () => q('section[aria-label="Permission request"]', agentsPanel());
const planCard = () => q('section[aria-label="Plan approval"]', agentsPanel());
const chipButton = () => q('.run-header button[aria-label^="Permission mode:"]', agentsPanel());
const chipLabel = () => text(chipButton());
const bypassChip = () => qa('.run-header [role="status"]', agentsPanel()).find((e) => text(e) === "BYPASS");
const BACKEND_ID = FX.repoIds[0];
const toasts = () => qa(".ui-toast").map(text);
const latest = async (role) => (await invoke("agent_list")).filter((a) => a.role === role).sort((a, b) => b.startedAt - a.startedAt)[0];
const eventsOf = async (agentId) => (await historyOf(agentId)).events;
const infos = (events) => events.filter((e) => e.kind === "session.info" && e.effective?.permission).map((e) => `${e.effective.permission}/${e.effective.reason ?? "user"}`);

/** Opens "New run" in Run-as-role form and picks a role and a repository; the mode is left alone (the caller decides). */
async function dialogFor(role, repoName) {
  await backToList();
  await clickButton("New run", agentsPanel());
  const pop = await waitFor(() => q(".newrun"), { what: "the New run dialog" });
  await roleMode(pop);
  const radio = await waitFor(() => qa('[role="radio"]', pop).find((b) => text(b).startsWith(role)), { what: `role ${role}` });
  radio.click();
  await waitFor(() => radio.getAttribute("aria-checked") === "true", { what: `role ${role} picked` });
  await sleep(150);
  for (const b of qa('[aria-label="Repositories"] button', pop)) {
    const want = text(b).includes(repoName);
    if ((b.getAttribute("aria-pressed") === "true") !== want) b.click();
  }
  await sleep(100);
  return pop;
}
async function backToList() {
  const back = qa(".chat__bar button", agentsPanel()).find((b) => /^Runs/.test(text(b)));
  if (back) { back.click(); await sleep(300); }
}
async function startFrom(pop, prompt) {
  await typeInto(q('textarea[aria-label="Prompt"]', pop), prompt);
  await clickButton("Start run", pop);
  await waitFor(() => q(".run-header"), { what: "the run header after Start", timeout: 60000 });
}
/** The header chip as a user drives it: open the menu, pick an item by its name, wait for the chip to read it. */
async function switchTo(label, { confirm = false } = {}) {
  chipButton().click();
  const menu = await waitFor(() => q('[role="menu"]'), { what: "the mode menu" });
  const item = qa('[role="menuitemradio"]', menu).find((i) => text(q(".ui-menu__title", i)) === label);
  if (!item) throw new Error(`the mode menu has no ${label}: ${qa('[role="menuitemradio"]', menu).map((i) => text(q(".ui-menu__title", i))).join(", ")}`);
  item.click();
  if (confirm) {
    const dlg = await waitFor(confirmDialog, { what: "the Bypass confirmation" });
    await clickButton("Use Bypass", dlg);
  }
  await waitFor(() => chipLabel() === label && !chipButton().getAttribute("aria-busy"), { what: `the chip to read ${label}`, timeout: 15000 });
}
async function stopRun() {
  await clickButton("Interrupt", agentsPanel());
  await waitFor(() => /You stopped this turn/.test(panelText()), { what: "the stop marker", timeout: 20000 });
  await waitFor(() => runStatusText() === "Done", { what: "Done after Interrupt" });
}

if (PHASE === 2) {
  // ---- pm2: the kill switch ------------------------------------------------------------------------------------------------------------------
  const offered = await invoke("agent_modes", { provider: "mock" });
  check("kill switch: agent_modes omits Automatic and Bypass", offered.join() === "readOnly,ask,edit", offered.join());
  const pop = await dialogFor("mock-interrupt", BACKEND);
  await waitFor(() => qa(".mode-card", pop).length > 0, { what: "the mode cards" });
  check("kill switch: the dialog offers Plan, Ask and Edit automatically only", cardsOf(pop).join() === "readOnly,ask,edit", mark(pop));
  check("kill switch: the nearest mode is preselected (Edit automatically), never a looser one", checkedMode(pop) === "edit", mark(pop));
  await shotBoth("modes-kill-switch");
  const refused = await invoke("agent_start", { req: { role: "mock-interrupt", repoIds: [BACKEND_ID], prompt: "x", mode: "automatic" } }).then(() => "started", (e) => e?.code ?? String(e));
  check("kill switch: agent_start refuses Automatic (modeDisabled)", refused === "modeDisabled", refused);
  const refusedBypass = await invoke("agent_start", { req: { role: "mock-interrupt", repoIds: [BACKEND_ID], prompt: "x", mode: "bypass" }, confirmBypass: true }).then(() => "started", (e) => e?.code ?? String(e));
  check("kill switch: agent_start refuses Bypass even when confirmed (modeDisabled)", refusedBypass === "modeDisabled", refusedBypass);
  await press("Escape");
  await finish();
} else {
  // ---- (a) the New run dialog opens in Automatic ---------------------------------------------------------------------------------------------
  step("a: the dialog");
  await clickButton("New run", agentsPanel());
  let pop = await waitFor(() => q(".newrun"), { what: "the New run dialog" });
  await waitFor(() => qa(".mode-card", pop).length > 0, { what: "the mode cards" });
  check("a: five mode cards in policy order", cardsOf(pop).join() === "readOnly,ask,edit,automatic,bypass", mark(pop));
  check("a: Automatic is selected the first time", checkedMode(pop) === "automatic", mark(pop));
  check("a: every card carries its one-line explanation", qa(".mode-card", pop).every((c) => text(q(".mode-card__hint", c)).length > 20), qa(".mode-card", pop).map((c) => text(q(".mode-card__hint", c))).join(" | ").slice(0, 300));
  check("a: the Bypass card announces a confirmation", modeCard(pop, "bypass")?.getAttribute("aria-haspopup") === "dialog");
  await shotBoth("modes-new-run");

  // ---- (b) Bypass opens its confirmation; Cancel restores ------------------------------------------------------------------------------------
  step("b: the Bypass confirmation");
  modeCard(pop, "bypass").click();
  let dlg = await waitFor(confirmDialog, { what: "the Bypass confirmation" });
  const keeps = qa('.bypass-confirm__list[data-kind="keeps"] > li', dlg).map((li) => li.dataset.id);
  check("b: the confirmation lists the ten hard stops Bypass keeps, git first", keeps.join() === "git,gitTricks,protectedPaths,persistence,secrets,wrangler,ideState,procEnv,isolation,catastrophic", keeps.join());
  check("b: it is honest about the limit of a static check", /not guaranteed/.test(text(dlg)) && /Rewind snapshots only/.test(text(dlg)), text(dlg).slice(0, 300));
  check("b: Cancel has the focus, the destructive button does not", document.activeElement === findButton("Cancel", dlg), String(document.activeElement?.outerHTML?.slice(0, 120)));
  check("b: the card has not changed yet", checkedMode(pop) === "automatic", mark(pop));
  await shotBoth("modes-bypass-confirm");
  await clickButton("Cancel", dlg);
  await waitFor(() => !confirmDialog(), { what: "the confirmation to close" });
  check("b: Cancel keeps the previous mode", checkedMode(pop) === "automatic", mark(pop));
  modeCard(pop, "bypass").click();
  await clickButton("Use Bypass", await waitFor(confirmDialog, { what: "the Bypass confirmation again" }));
  await waitFor(() => checkedMode(pop) === "bypass", { what: "Bypass selected after confirming" });
  await shotBoth("modes-new-run-bypass");
  await pickMode(pop, "ask");
  check("b: picking another card leaves Bypass at once", checkedMode(pop) === "ask", mark(pop));
  await press("Escape");
  await waitFor(() => !q(".newrun"), { what: "the dialog to close" });

  // ---- (c) an Automatic run asks nothing -----------------------------------------------------------------------------------------------------
  step("c: Automatic run");
  if (haveRole("mock-bash-twice")) {
    pop = await dialogFor("mock-bash-twice", BACKEND);
    await pickMode(pop, "automatic");
    await startFrom(pop, "run it twice");
    await waitFor(() => runStatusText() === "Done", { what: "Done in Automatic", timeout: 60000 });
    const run = await latest("mock-bash-twice");
    const ev = await eventsOf(run.agentId);
    check("c: an Automatic run shows no permission card", !permCard() && !ev.some((e) => e.kind === "permission.request"), `${ev.filter((e) => e.kind === "permission.request").length} requests`);
    check("c: both Bash calls ran", ev.filter((e) => e.kind === "tool.result" && e.status === "ok").length >= 2 && /Both runs finished/.test(panelText()), panelText().slice(0, 300));
    check("c: the header says Automatic, with no BYPASS chip", chipLabel() === "Automatic" && !bypassChip(), `${chipLabel()} / ${!!bypassChip()}`);
    check("c: the host recorded the mode", run.permission === "automatic", run.permission);
    await shotBoth("modes-run-automatic");
  }

  // ---- (c2) the session allow ----------------------------------------------------------------------------------------------------------------
  step("c2: allow always in this session");
  if (haveRole("mock-bash-twice")) {
    pop = await dialogFor("mock-bash-twice", ADMIN);
    await pickMode(pop, "ask");
    await startFrom(pop, "run it twice, asking");
    const card = await waitFor(permCard, { what: "the permission card of the first Bash call", timeout: 60000 });
    const labels = qa("button", card).map((b) => text(b));
    check("c2: the card offers allow once, allow always in this session, deny", ["Allow once", "Allow always in this session", "Deny"].every((l) => labels.includes(l)), labels.join(" | "));
    const scope = q(".perm__scope", card);
    check("c2: the card says exactly what the button allows, and that it is never saved", /Always in this session: allows .* commands/.test(text(scope)) && /Never saved to disk/.test(text(scope)), text(scope));
    await shotBoth("modes-permission-session-allow");
    findButton("Allow always in this session", card).click();
    await waitFor(() => runStatusText() === "Done", { what: "Done after the session allow", timeout: 60000 });
    const run = await latest("mock-bash-twice");
    const ev = await eventsOf(run.agentId);
    check("c2: the same command the second time ran without a card", ev.filter((e) => e.kind === "permission.request").length === 1 && ev.filter((e) => e.kind === "tool.result" && e.status === "ok").length >= 2, `${ev.filter((e) => e.kind === "permission.request").length} requests`);
    check("c2: the first card resolved as allowed for the session by you", /Allowed always in this session by you/.test(panelText()), panelText().slice(0, 400));
  }

  // ---- (d, e) the header chip: a live switch, and the BYPASS chip ----------------------------------------------------------------------------
  step("d: the header chip");
  if (haveRole("mock-interrupt")) {
    pop = await dialogFor("mock-interrupt", SERVICES);
    await pickMode(pop, "automatic");
    await startFrom(pop, "run for a long time");
    await waitFor(() => /sleep 30|Bash/.test(panelText()), { what: "the running tool", timeout: 30000 });
    const run = await latest("mock-interrupt");
    check("d: the chip shows Automatic and is a menu", chipLabel() === "Automatic" && chipButton().getAttribute("aria-haspopup") === "menu", `${chipLabel()}`);
    chipButton().click();
    const menu = await waitFor(() => q('[role="menu"]'), { what: "the mode menu" });
    const titles = qa('[role="menuitemradio"]', menu).map((i) => text(q(".ui-menu__title", i)));
    check("d: the menu lists the five modes with the current one checked", titles.join() === "Plan / read only,Ask,Edit automatically,Automatic,Bypass" && qa('[role="menuitemradio"]', menu).find((i) => i.getAttribute("aria-checked") === "true")?.textContent.includes("Automatic"), titles.join());
    await shotBoth("modes-header-menu");
    await press("Escape");
    await waitFor(() => !q('[role="menu"]'), { what: "the menu to close" });

    await switchTo("Ask");
    check("d: the host recorded Ask and the event log says so", (await invoke("agent_list")).find((a) => a.agentId === run.agentId)?.permission === "ask" && infos(await eventsOf(run.agentId)).includes("ask/user"), infos(await eventsOf(run.agentId)).join());
    await switchTo("Plan / read only");
    check("d: then Plan: the chip follows the effective mode", chipLabel() === "Plan / read only" && !bypassChip(), chipLabel());
    check("d: a tightening says that programs already started keep running", toasts().some((t) => /already started keep running/.test(t)), toasts().join(" | "));

    step("e: BYPASS");
    await switchTo("Bypass", { confirm: true });
    await waitFor(() => bypassChip(), { what: "the BYPASS chip" });
    check("e: the red BYPASS chip and the danger edge show while the run is in Bypass", !!bypassChip() && q(".run-header", agentsPanel()).hasAttribute("data-bypass"), "");
    check("e: the effective mode followed (session.info reached the view)", chipLabel() === "Bypass", chipLabel());
    await shotBoth("modes-header-bypass");
    await switchTo("Automatic");
    await waitFor(() => !bypassChip(), { what: "the BYPASS chip to go away" });
    check("e: it disappears as soon as the mode changes", !bypassChip() && !q(".run-header", agentsPanel()).hasAttribute("data-bypass"), chipLabel());
    const ev = await eventsOf(run.agentId);
    check("e: the log carries the four switches in order", infos(ev).filter((s, i, all) => i === 0 || s !== all[i - 1]).slice(-4).join() === "ask/user,readOnly/user,bypass/user,automatic/user", infos(ev).join());
    await stopRun();
  }

  // ---- (f) the Plan approval card -------------------------------------------------------------------------------------------------------------
  step("f: plan approval");
  if (haveRole("mock-plan-approval")) {
    pop = await dialogFor("mock-plan-approval", POS);
    check("f: a read-only role preselects Plan, and says so", checkedMode(pop) === "readOnly" && /Plan is preselected/.test(text(pop)), mark(pop));
    await startFrom(pop, "plan it");
    const card = await waitFor(planCard, { what: "the plan approval card", timeout: 60000 });
    check("f: the card carries the full plan", /First I add the helper to the module/.test(text(card)) && /Then I switch the two call sites/.test(text(card)), text(card).slice(0, 300));
    const options = qa(".mode-card", card).map((c) => c.dataset.mode);
    check("f: it offers Ask, Edit automatically and Automatic, never Bypass", options.join() === "ask,edit,automatic", options.join());
    check("f: Ask is preselected, Automatic never", qa(".mode-card", card).find((c) => c.getAttribute("aria-checked") === "true")?.dataset.mode === "ask", qa(".mode-card", card).map((c) => `${c.dataset.mode}:${c.getAttribute("aria-checked")}`).join(" "));
    check("f: Approve plan is the one primary button and takes the focus", card.contains(document.activeElement) && findButton("Approve plan", card)?.hasAttribute("data-primary"), String(document.activeElement?.outerHTML?.slice(0, 120)));
    await shotBoth("modes-plan-card");
    q('.mode-card[data-mode="automatic"]', card).click();
    check("f: picking Automatic shows that it will not ask again, and still waits for Approve", /will not ask again/.test(text(card)) && !!planCard(), text(card).slice(-200));
    await shotBoth("modes-plan-card-automatic");
    q('.mode-card[data-mode="edit"]', card).click();
    findButton("Approve plan", card).click();
    await waitFor(() => chipLabel() === "Edit automatically", { what: "the header to read Edit automatically after approving", timeout: 20000 });
    await waitFor(() => /Continuing in/.test(panelText()), { what: "the model continuing", timeout: 20000 });
    check("f: approving with Edit automatically switches the run (header, host, event log)", (await latest("mock-plan-approval")).permission === "edit" && infos(await eventsOf((await latest("mock-plan-approval")).agentId)).includes("edit/planApproved"), infos(await eventsOf((await latest("mock-plan-approval")).agentId)).join());
    check("f: the resolved row names the mode and keeps the plan collapsed", /Plan approved, continuing in Edit automatically/.test(panelText()) && !!q("details.plan-approval__show:not([open])", agentsPanel()), panelText().slice(0, 400));
    await waitFor(() => runStatusText() === "Done", { what: "Done after the plan was approved", timeout: 60000 });

    step("f2: reject with a note");
    pop = await dialogFor("mock-plan-approval", SERVICES);
    await startFrom(pop, "plan it again");
    const card2 = await waitFor(planCard, { what: "the second plan approval card", timeout: 60000 });
    findButton("Request changes", card2).click();
    const note = await waitFor(() => q(".plan-approval__feedback textarea", card2), { what: "the feedback field" });
    check("f2: Send feedback needs a note", findButton("Send feedback", card2)?.disabled === true);
    await shotBoth("modes-plan-feedback");
    await typeInto(note, "Keep the tests untouched");
    findButton("Send feedback", card2).click();
    await waitFor(() => /Revising: Keep the tests untouched/.test(panelText()), { what: "the model revising with the note", timeout: 30000 });
    check("f2: the note came back to the model verbatim and Plan stayed", chipLabel() === "Plan / read only" && /Plan sent back: Keep the tests untouched/.test(panelText()), `${chipLabel()} / ${panelText().slice(0, 300)}`);
    const again = await waitFor(planCard, { what: "the plan card asked once more", timeout: 30000 });
    findButton("Approve plan", again).click();
    await waitFor(() => runStatusText() === "Done", { what: "Done after the second approval", timeout: 60000 });
    check("f2: approving the revised plan continues in Ask", (await latest("mock-plan-approval")).permission === "ask" || chipLabel() === "Ask", chipLabel());
  }

  // ---- (h) a card opened in Ask is withdrawn by a switch to Plan ---------------------------------------------------------------------------
  step("h: a card withdrawn by a switch");
  if (haveRole("mock-bash-twice")) {
    pop = await dialogFor("mock-bash-twice", BACKEND);
    await pickMode(pop, "ask");
    await startFrom(pop, "run it twice, then switch");
    await waitFor(permCard, { what: "the permission card in Ask", timeout: 60000 });
    const run = await latest("mock-bash-twice");
    await switchTo("Plan / read only");
    await waitFor(() => !permCard() && /Withdrawn: the rules changed while this was waiting/.test(panelText()), { what: "the card to be withdrawn", timeout: 20000 });
    check("h: the card turned into the withdrawn row and nothing is left to click", !permCard() && !qa("button", agentsPanel()).some((b) => text(b) === "Allow once"), panelText().slice(0, 300));
    const ev = await eventsOf(run.agentId);
    check("h: the denial is in the log, and no Bash call ran in Plan", ev.some((e) => e.kind === "permission.resolved" && e.outcome === "deny") && !ev.some((e) => e.kind === "tool.result" && e.status === "ok" && /twice/.test(JSON.stringify(e))), JSON.stringify(ev.filter((e) => e.kind === "permission.resolved")).slice(0, 300));
  }

  // ---- the stored runs ---------------------------------------------------------------------------------------------------------------------------
  const list = await invoke("agent_list");
  for (const a of list) {
    const h = await historyOf(a.agentId);
    check(`log of ${a.role}: gap-free, tools and turns paired`, h.problems.length === 0, h.problems.join("; "));
  }
  await finish();
}
