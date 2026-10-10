import { createEffect, createRoot, on } from "solid-js";
import { ipc } from "../../ipc";
import { setAppMode } from "../../platform/mode";
import { agentRows, agentView, needsYouCount, selectAgent } from "../../store/agents";
import { pendingPermissions, pendingQuestions } from "../../store/agent-reducer";
import { createAnnouncer } from "./announcer";
import { readNotify, runToShow, toPrefs, type Shown } from "./logic";
import { applyNotifySettings, notifySettings } from "./state";

// The runtime of the run notifications: banners on state changes, the Dock badge, and bringing the run forward when the window
// is focused soon after a banner (macOS activates the app on a click). Started once by the overlay; independent of the menu-bar item.
let started = false;

export async function startNotify(): Promise<void> {
  if (started) return;
  started = true;
  try {
    applyNotifySettings(readNotify(await ipc.settings.get("notify")));
  } catch {
    // the defaults stay
  }
  ipc.settings.onChange((e) => {
    if (e.ns === "notify") applyNotifySettings(readNotify(e.value as Record<string, unknown>));
  });
  createRoot(() => {
    let shown: Shown | undefined;
    const announcer = createAnnouncer({
      rows: agentRows,
      needs: (id) => {
        const v = agentView(id);
        return v && pendingQuestions(v).length && !pendingPermissions(v).length ? "question" : "permission";
      },
      show: (req) => ipc.notify.show(req),
      shown: (runId) => (shown = { runId, at: Date.now() }),
    });
    // the gate in Rust gets every change of the settings
    createEffect(() => void ipc.notify.configure(toPrefs(notifySettings())).catch(() => undefined));
    // the Dock badge: how many runs wait for you
    createEffect(() => {
      const s = notifySettings();
      void ipc.notify.badge(s.badge && s.enabled ? needsYouCount() : 0).catch(() => undefined);
    });
    createEffect(on(agentRows, () => announcer.update()));
    // the click on a banner activates the app: the run it was about comes forward
    window.addEventListener("focus", () => {
      const id = runToShow(shown, Date.now(), (runId) => agentRows().find((r) => r.agentId === runId)?.status);
      shown = undefined;
      if (!id) return;
      setAppMode("agent");
      void selectAgent(id);
    });
  });
}
