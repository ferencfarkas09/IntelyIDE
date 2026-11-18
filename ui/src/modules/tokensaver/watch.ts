// "Nudge automatically" (off by default): while a turn of a run is working, a file that crosses the repeated-read warning gets
// the same note "Tell the agent" sends, at most once per file and run. It never starts a turn and never sends a message
// between turns: a run whose provider takes no notes is left alone. Checked a moment after the run's log changes.
import { createEffect, createRoot, onCleanup } from "solid-js";
import { agentRows } from "../../store/agents";
import { buildCockpit } from "../history/cockpit";
import { loadRunLog, runLog } from "../inspector/runEvents";
import { ledger, route, sendNudge } from "./actions";
import { pendingNudges } from "./logic";
import { autoNudge } from "./prefs";

const DEBOUNCE_MS = 1500;

/** One check of one run: the first file not nudged yet, as a note. Returns the path sent, if any. */
export async function checkRun(runId: string, model?: string): Promise<string | undefined> {
  if (route(runId) !== "note") return undefined;
  const events = runLog(runId)?.events ?? [];
  const [next] = pendingNudges(runId, buildCockpit(events, model).warnings, ledger);
  if (!next) return undefined;
  return (await sendNudge(runId, next.path, next.count, true).catch(() => false)) ? next.path : undefined;
}

/** Starts the watcher; the returned function stops it. */
export function startAutoNudge(): () => void {
  return createRoot((dispose) => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    createEffect(() => {
      if (!autoNudge()) return;
      for (const row of agentRows()) {
        if (row.status !== "running") continue;
        const log = runLog(row.agentId);
        if (!log) {
          void loadRunLog(row.agentId);
          continue;
        }
        void log.events.length; // re-run when the log grows
        clearTimeout(timers.get(row.agentId));
        timers.set(row.agentId, setTimeout(() => void checkRun(row.agentId, row.model), DEBOUNCE_MS));
      }
    });
    onCleanup(() => timers.forEach((id) => clearTimeout(id)));
    return dispose;
  });
}
