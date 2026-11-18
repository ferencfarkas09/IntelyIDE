// What the token saver's buttons do. A nudge goes into the run as a note while a turn is working (when the provider takes
// notes), otherwise as the next message; "Compact the conversation" sends the CLI's own `/compact` between turns, and only
// when the run's CLI listed that command; "Continue in a fresh run" only fills the New Run dialog: nothing starts by itself.
import { createSignal } from "solid-js";
import { t } from "../../i18n";
import { maskForPrompt } from "../../ipc/vibe";
import { requestNewRun } from "../../platform/newRun";
import { agentRow, agentView, sendMessage, sendNote } from "../../store/agents";
import { buildCockpit } from "../history/cockpit";
import { loadRunLog, runLog } from "../inspector/runEvents";
import { runSummaryApi } from "../runsummary/api";
import { bullets } from "../runsummary/logic";
import { buildHandoffPrompt, firstPrompt, handoffOffered, NudgeLedger, nudgeText, originalTask } from "./logic";

export const ledger = new NudgeLedger();
/** Bumped on every nudge so the buttons re-read the ledger. */
const [version, setVersion] = createSignal(0);
export const nudged = (runId: string, path: string): boolean => (version(), ledger.has(runId, path));

/** How a message reaches the run now: a note into the working turn, the next message, or not at all. */
export function route(runId: string): "note" | "message" | "none" {
  const view = agentView(runId);
  const row = agentRow(runId);
  if (!row) return "none";
  if (view?.turnActive) return (view.caps ?? row.caps)?.notes === true ? "note" : "none";
  return "message";
}

/**
 * Tells the run about one file it keeps re-reading, once per file and run. `auto` (Nudge automatically) only ever adds a note
 * to a turn that is working: it never starts a new turn by itself. Resolves false when nothing was sent.
 */
export async function sendNudge(runId: string, path: string, count: number, auto = false): Promise<boolean> {
  const how = route(runId);
  if (how === "none" || (auto && how !== "note")) return false;
  if (!ledger.claim(runId, path)) return false;
  setVersion((n) => n + 1);
  try {
    const text = nudgeText(path, count);
    if (how === "note") await sendNote(runId, text);
    else await sendMessage(runId, text);
    return true;
  } catch (e) {
    ledger.release(runId, path);
    setVersion((n) => n + 1);
    throw e;
  }
}

/** The run's CLI offers `/compact` (it listed it at start) and no turn is working: the command can go as the next message. */
export const canCompact = (runId: string): boolean => (agentRow(runId)?.slashCommands ?? []).includes("compact");
export const compactBusy = (runId: string): boolean => agentView(runId)?.turnActive === true;

export const compact = (runId: string): Promise<void> => sendMessage(runId, "/compact");

/** The run's log, read and ready: waits for a read that is under way (up to `waitMs`). Throws when it cannot be read. */
async function readyLog(runId: string, waitMs = 10_000): Promise<NonNullable<ReturnType<typeof runLog>>> {
  await loadRunLog(runId);
  const until = Date.now() + waitMs;
  while (runLog(runId)?.status === "loading" && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  const log = runLog(runId);
  if (!log || log.status !== "ready") throw new Error(t("tokensaver.fresh.noLog"));
  return log;
}

/**
 * Opens New Run with the hand-off prompt, the run's repositories, role, mode and model. Resolves false when the dialog did not
 * open. The run's log is read first (never "(empty)" for a task that was only not loaded yet); the changed files come from it
 * unless the caller has them. Not for a run on a server (see `handoffOffered`).
 */
export async function continueFresh(runId: string, changedFiles?: readonly string[]): Promise<boolean> {
  const row = agentRow(runId);
  if (!handoffOffered(row)) throw new Error(t("tokensaver.fresh.server"));
  const log = await readyLog(runId);
  const changed = changedFiles ?? buildCockpit(log.events, row?.model ?? "").files.filter((f) => f.edits > 0).map((f) => f.path);
  const digest = await runSummaryApi().digest(runId).catch(() => null);
  const { prompt, reduced } = await buildHandoffPrompt({ originalPrompt: originalTask(firstPrompt(log.events)), summary: digest ? bullets(digest) : [], changedFiles: changed }, maskForPrompt);
  const permission = row?.permission && row.permission !== "bypass" ? row.permission : undefined;
  return requestNewRun({
    prompt,
    ...(row?.repoIds.length ? { repoIds: row.repoIds } : {}),
    ...(permission ? { permission } : {}),
    ...(row?.role ? { role: row.role } : {}),
    ...(row?.model ? { model: row.model } : {}),
    ...(reduced ? { error: t("toAgent.reducedMask") } : {}),
  });
}

/** Test helper. */
export function resetActions(): void {
  ledger.clear();
  setVersion(0);
}
