import { t } from "../../i18n";
import { ipc } from "../../ipc";

let watching: (() => void) | undefined;

/** A teammate changed a CLAUDE.md: a banner through the existing notify gate (kind switches, throttle, focus rule). Never throws. Once per page. */
export function watchMemory(): void {
  if (watching) return;
  const off = ipc.team.memory.onPending((p) => {
    void ipc.notify
      .show({ kind: "question", title: t("team.mem.pendingBanner", { name: p.author, project: p.projectName }), body: t("team.mem.pendingBannerBody"), runId: `memory:${p.project}` })
      .catch(() => undefined);
  });
  watching = () => off();
}
