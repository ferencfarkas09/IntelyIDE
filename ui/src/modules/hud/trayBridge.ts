import { createEffect, on } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { execute } from "../../platform/commands";
import { setAppMode } from "../../platform/mode";
import { agentRows, agentView, interruptRun, selectAgent } from "../../store/agents";
import { pendingPermissions, pendingQuestions } from "../../store/agent-reducer";
import { timerView } from "../../store/happy";
import type { NotifyKind } from "../../ipc/tray";

// Feeds the menu-bar item: counts and timer go out as they change, notifications fire on state transitions of runs, and the
// menu's actions come back. Created inside a root by the watcher while the tray is enabled; `stopTrayBridge` ends the actions.
let offAction: (() => void) | undefined;

export interface Transition {
  kind: NotifyKind;
  title: string;
  body: string;
}

/** What a run's change of state is worth a notification for. `needs` carries the kind of the pending request. */
export function transitionOf(prev: string | undefined, next: string, title: string, needs?: "permission" | "question"): Transition | undefined {
  if (prev === undefined || prev === next) return undefined;
  if (next === "needsYou") return needs === "question" ? { kind: "question", title: t("hud.notify.question"), body: title } : { kind: "permission", title: t("hud.notify.permission"), body: title };
  if (next === "done" && prev === "running") return { kind: "finished", title: t("hud.notify.finished"), body: title };
  if (next === "error") return { kind: "error", title: t("hud.notify.failed"), body: title };
  return undefined;
}

export function startTrayBridge(): void {
  const last = new Map<string, string>();
  createEffect(() => {
    const rows = agentRows();
    const timer = timerView();
    void ipc.tray.update({ running: rows.filter((r) => r.status === "running").length, needsYou: rows.filter((r) => r.status === "needsYou").length, timer: timer.phase === "idle" ? "" : timer.phase, timerLabel: timer.title }).catch(() => undefined);
  });
  createEffect(
    on(agentRows, (rows) => {
      for (const r of rows) {
        const v = agentView(r.agentId);
        const needs = v && pendingQuestions(v).length && !pendingPermissions(v).length ? "question" : "permission";
        const tr = transitionOf(last.get(r.agentId), r.status, r.title || r.role, needs);
        last.set(r.agentId, r.status);
        if (tr) void ipc.tray.notify(tr).catch(() => undefined);
      }
    }),
  );
  offAction?.();
  offAction = ipc.tray.onAction((id) => {
    if (id === "new-run") void execute("runs.new");
    else if (id === "needs-you") {
      const row = agentRows().find((r) => r.status === "needsYou");
      setAppMode("agent");
      if (row) void selectAgent(row.agentId);
    } else if (id === "stop-all") for (const r of agentRows()) if (r.status === "running") void interruptRun(r.agentId);
  });
}

export function stopTrayBridge(): void {
  offAction?.();
  offAction = undefined;
}
