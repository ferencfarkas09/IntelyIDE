import type { NotifyRequest, NotifyVerdict } from "../../ipc/notify";
import { SETTLE_MS, transitionOf } from "./logic";

export interface RowLike {
  agentId: string;
  status: string;
  title?: string;
  role: string;
}

export interface AnnouncerDeps {
  rows(): RowLike[];
  /** What the run waits for, when its state is `needsYou`. */
  needs(agentId: string): "permission" | "question";
  show(req: NotifyRequest): Promise<NotifyVerdict>;
  /** A banner was really shown for this run. */
  shown(runId: string): void;
  settleMs?: number;
}

/**
 * Turns changes of run state into banners. A new state must last for `settleMs` before it is announced: a request that a saved
 * rule or the hard stop answers within a moment never needed the person, and a banner for it would only be noise.
 */
export function createAnnouncer(deps: AnnouncerDeps): { update(): void; dispose(): void } {
  const last = new Map<string, string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const settle = deps.settleMs ?? SETTLE_MS;
  return {
    update() {
      for (const r of deps.rows()) {
        const tr = transitionOf(last.get(r.agentId), r.status, r.status === "needsYou" ? deps.needs(r.agentId) : undefined);
        last.set(r.agentId, r.status);
        const waiting = timers.get(r.agentId);
        if (waiting) {
          clearTimeout(waiting);
          timers.delete(r.agentId);
        }
        if (!tr) continue;
        const { agentId, status } = r;
        const subtitle = r.title || r.role;
        timers.set(
          agentId,
          setTimeout(() => {
            timers.delete(agentId);
            if (deps.rows().find((x) => x.agentId === agentId)?.status !== status) return;
            void deps
              .show({ kind: tr.kind, title: tr.title, body: tr.body, runId: agentId, subtitle })
              .then((verdict) => {
                if (verdict === "show") deps.shown(agentId);
              })
              .catch(() => undefined);
          }, settle),
        );
      }
    },
    dispose() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      last.clear();
    },
  };
}
