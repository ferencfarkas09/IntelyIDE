import { createEffect } from "solid-js";
import { ipc } from "../../ipc";
import { execute } from "../../platform/commands";
import { setAppMode } from "../../platform/mode";
import { agentRows, interruptRun, selectAgent } from "../../store/agents";
import { timerView } from "../../store/happy";

// Feeds the menu-bar item: counts and timer go out as they change, and the menu's actions come back. Created inside a root by the
// watcher while the tray is enabled; `stopTrayBridge` ends the actions. (Banners for runs are the notify module's.)
let offAction: (() => void) | undefined;

export function startTrayBridge(): void {
  createEffect(() => {
    const rows = agentRows();
    const timer = timerView();
    void ipc.tray.update({ running: rows.filter((r) => r.status === "running").length, needsYou: rows.filter((r) => r.status === "needsYou").length, timer: timer.phase === "idle" ? "" : timer.phase, timerLabel: timer.title }).catch(() => undefined);
  });
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
