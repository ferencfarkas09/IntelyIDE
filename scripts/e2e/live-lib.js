// Helpers of the LIVE permission scenarios jc, jd, je and jf (run.sh concatenates config.js, lib.js, agents-lib.js, this file and one scenario).
const planCard = () => q('section[aria-label="Plan approval"]', agentsPanel());
const chipButton = () => q('.run-header button[aria-label^="Permission mode:"]', agentsPanel());
const chipLabel = () => text(chipButton());
const bypassDialog = () => qa('[role="alertdialog"]').find((d) => /Switch on Bypass\?/.test(text(d)));

/** Like pickMode, but Bypass opens its confirmation: accept it. */
async function pickModeConfirm(pop, mode) {
  if (mode !== "bypass") return pickMode(pop, mode);
  const card = await waitFor(() => modeCard(pop, "bypass"), { what: "the bypass mode card" });
  card.click();
  await clickButton("Use Bypass", await waitFor(bypassDialog, { what: "the Bypass confirmation" }));
  await waitFor(() => checkedMode(pop) === "bypass", { what: "Bypass selected after confirming" });
}

/** Opens New run on the Auto lead (no role), picks the repo and the mode, types the prompt and starts. */
async function newAutoRun(repoName, prompt, { mode = "automatic" } = {}) {
  await clickButton("New run", agentsPanel());
  const pop = await waitFor(() => q(".newrun"), { what: "the New run popover" });
  await waitFor(() => qa(".mode-card", pop).length > 0, { what: "the mode cards of New run", timeout: 30000 });
  await pickModeConfirm(pop, mode);
  for (const b of qa('[aria-label="Repositories"] button', pop)) {
    const want = text(b).includes(repoName);
    if ((b.getAttribute("aria-pressed") === "true") !== want) b.click();
  }
  await sleep(100);
  await typeInto(q('textarea[aria-label="Prompt"]', pop), prompt);
  await clickButton("Start run", pop);
  await waitFor(() => q(".run-header"), { what: "the run header after Start", timeout: 60000 });
}

/** A role run (Run as role...) with a mode that may be Bypass. */
async function newRoleRun(role, repoNames, prompt, mode) {
  await clickButton("New run", agentsPanel());
  const pop = await waitFor(() => q(".newrun"), { what: "the New run popover" });
  await roleMode(pop);
  const radio = await waitFor(() => qa('[role="radio"]', pop).find((b) => text(b).startsWith(role)), { what: `role ${role}` });
  radio.click();
  await waitFor(() => radio.getAttribute("aria-checked") === "true", { what: `role ${role} picked` });
  await sleep(150);
  await pickModeConfirm(pop, mode);
  for (const b of qa('[aria-label="Repositories"] button', pop)) {
    const want = repoNames.some((n) => text(b).includes(n));
    if ((b.getAttribute("aria-pressed") === "true") !== want) b.click();
  }
  await sleep(100);
  await typeInto(q('textarea[aria-label="Prompt"]', pop), prompt);
  await clickButton("Start run", pop);
  await waitFor(() => q(".run-header"), { what: "the run header after Start", timeout: 60000 });
}

async function backToRuns() {
  const back = qa(".chat__bar button", agentsPanel()).find((b) => /^Runs/.test(text(b)));
  if (back) { back.click(); await sleep(300); }
}

const readRepoFile = async (relPath) => (await invoke("files_read_file", { repoId: "shop-pos", relPath }).catch(() => null))?.text ?? null;
const latestRun = async () => (await invoke("agent_list")).sort((a, b) => b.startedAt - a.startedAt)[0];

/** The permission events of a log as compact lines (kind, who decided, outcome, rule, short message): never file contents. */
function permLines(events) {
  return events.filter((e) => /^permission\./.test(e.kind)).map((e) =>
    [e.kind, e.by ?? "", e.outcome ?? "", e.rule ?? "", e.hardStop ?? "", String(e.message ?? e.reason ?? e.tool ?? "").slice(0, 140)].join(" | "));
}
const toolInputs = (events) => events.filter((e) => e.kind === "tool.start").map((s) => ({ ...s, ok: events.some((e) => e.kind === "tool.result" && e.toolId === s.toolId && e.status === "ok") }));
/** Resolutions that needed the person: a card that was shown (by "user"). A request answered at once by a hard stop or a role rule never shows a card. */
const askedUser = (events) => events.filter((e) => e.kind === "permission.resolved" && e.by === "user");
