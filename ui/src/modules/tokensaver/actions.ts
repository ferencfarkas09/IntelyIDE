// What the token saver's buttons do. A nudge goes into the run as a note while a turn is working (when the provider takes
// notes), otherwise as the next message; "Compact the conversation" sends the CLI's own `/compact` between turns, and only
// when the run's CLI listed that command; "Continue in a fresh run" only fills the New Run dialog: nothing starts by itself.
import { createSignal } from "solid-js";
import { t } from "../../i18n";
import { maskForPrompt } from "../../ipc/vibe";
import { requestNewRun } from "../../platform/newRun";
import { agentRow, agentView, sendMessage, sendNote } from "../../store/agents";
import { runLog } from "../inspector/runEvents";
import { runSummaryApi } from "../runsummary/api";
import { bullets } from "../runsummary/logic";
import { buildHandoffPrompt, firstPrompt, NudgeLedger, nudgeText } from "./logic";

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

/** Opens New Run with the hand-off prompt, the run's repositories, role, mode and model. Resolves false when the dialog did not open. */
export async function continueFresh(runId: string, changedFiles: readonly string[]): Promise<boolean> {
  const row = agentRow(runId);
  const digest = await runSummaryApi().digest(runId).catch(() => null);
  const { prompt, reduced } = await buildHandoffPrompt({ originalPrompt: firstPrompt(runLog(runId)?.events ?? []), summary: digest ? bullets(digest) : [], changedFiles }, maskForPrompt);
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
