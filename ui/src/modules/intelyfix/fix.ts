// IntelyFIX: what one press of "Fix" does. The issue is read (with its newest event), given to whoever Settings says, the repositories
// are worked out, the prompt is built, and a run starts on them: all of that in one click. Whatever needs a person's decision (no
// repository could be told, the host refuses the start, or the person asked to review the prompt first) opens the New run dialog filled
// in instead, with the reason, so one click never starts something the app would have asked about. The agent edits; it never commits or
// pushes: the person reads the change in the Changes tree and commits it.
import { t } from "../../i18n";
import { openDockTab } from "../../platform/dock";
import { appMode } from "../../platform/mode";
import { requestNewRun } from "../../platform/newRun";
import { startRun } from "../../store/agents";
import { snapshots } from "../../store/snapshots";
import { repos } from "../../store/workspace";
import { toast } from "../../ui-kit";
import { problemOf, sentryApi } from "../sentry/api";
import { activeRunOf, expectRun, forgetExpectedRun, linkRun, links, showRun } from "../sentry/links";
import { fixTitleStart } from "../sentry/logic";
import { assignMe, assignTo } from "../sentry/store";
import type { SentryDetail, SentryIssue } from "../sentry/types";
import { fixPrefs, loadFixPrefs, type FixAssignee } from "./prefs";
import { buildPrompt } from "./prompt";
import { pickFixRepos, type FixRepos } from "./repos";

/** `started`: the run is working. `dialog`: the New run dialog is open, filled in. `running`: a run for this issue is already working. `failed`: nothing started. */
export type FixOutcome = "started" | "dialog" | "running" | "failed";

/** Gives the issue to whoever the settings say. A failure (a token that is not a person's, a missing scope) is told and never stops the fix. */
async function assignFor(issue: SentryIssue, who: FixAssignee): Promise<SentryIssue | undefined> {
  try {
    if (who.mode === "none") return undefined;
    if (who.mode === "me") return await assignMe(issue.id);
    if (issue.assignedTo?.kind === who.kind && issue.assignedTo.id === who.id) return undefined;
    return await assignTo(issue.id, { kind: who.kind, id: who.id });
  } catch (e) {
    toast.warn(t("sentry.fix.notAssigned"), problemOf(e).message);
    return undefined;
  }
}

const namesOf = (repoList: FixRepos["primary"]): string[] => repoList.map((r) => r.name);

/** Opens the New run dialog with the prompt and the repositories, and finds the run again by its title when it starts. */
async function review(issue: SentryIssue, prompt: string, repoIds: string[], why?: { error?: string; noSafetyNet?: boolean }): Promise<FixOutcome> {
  expectRun(issue, fixTitleStart(issue));
  const opened = await requestNewRun({ prompt, repoIds, ...why });
  if (!opened) {
    forgetExpectedRun();
    toast.error(t("sentry.fix.noDialog"));
    return "failed";
  }
  return "dialog";
}

/**
 * Fix this issue now. `review` asks for the dialog even when Settings say to start at once.
 * Rejects (with a `SentryProblem`) only when the issue itself cannot be read; every later problem is a notice or the dialog.
 */
export async function fixIssue(issueId: string, opts: { review?: boolean } = {}): Promise<FixOutcome> {
  const running = activeRunOf(issueId);
  if (running && !opts.review) {
    toast.info(t("intelyfix.fix.running", { id: links()[running]?.shortId ?? issueId }));
    showRun(running);
    return "running";
  }
  const [detail] = await Promise.all([sentryApi().issue(issueId).catch((e) => Promise.reject(problemOf(e))), loadFixPrefs()]);
  const prefs = fixPrefs();
  const found = pickFixRepos(detail.issue.project?.slug, prefs.repoMap, repos());
  const assigned = await assignFor(detail.issue, prefs.assignee);
  const issue: SentryIssue = assigned ? { ...detail.issue, ...assigned, count: assigned.count || detail.issue.count } : detail.issue;
  const withIssue: SentryDetail = { ...detail, issue };

  const primaryBranch = found?.primary[0] ? snapshots()[found.primary[0].id]?.head.branch : undefined;
  const { text: prompt } = buildPrompt({ detail: withIssue, template: prefs.template, repos: found && { primary: namesOf(found.primary), related: namesOf(found.related) }, branch: primaryBranch ?? undefined });
  const repoIds = found ? [...found.primary, ...found.related].map((r) => r.id) : [];

  if (!found) toast.info(t("intelyfix.fix.noRepo", { project: issue.project?.slug ?? "?" }));
  if (opts.review || prefs.start === "review" || !found) return review(issue, prompt, repoIds);

  try {
    const run = await startRun({ role: prefs.role, repoIds, prompt, mode: prefs.permission });
    linkRun(run.agentId, issue);
    if (appMode() === "editor") openDockTab("agents");
    toast.show({
      title: t("intelyfix.fix.started", { id: issue.shortId }),
      description: t("intelyfix.fix.startedDesc", { repos: namesOf([...found.primary, ...found.related]).join(", ") }),
      tone: "ok",
      duration: 6000,
      action: { label: t("intelyfix.openRun"), onSelect: () => showRun(run.agentId) },
    });
    return "started";
  } catch (e) {
    // a refusal is the host asking for a decision (no safety net, a mode it will not run, the write lease, no free slot): the dialog is where that is answered
    const err = e as { code?: string; message?: string } | null;
    return review(issue, prompt, repoIds, { error: err?.message ?? String(e), noSafetyNet: err?.code === "noSafetyNet" });
  }
}
