import type { NotifyIpc, NotifyKind, NotifyPrefs, NotifyRequest, NotifyVerdict } from "../notify";

/** Mirrors the Rust gate (master switch, per-kind switch, never while focused, throttle per kind and run, burst cap) so UI tests see the same verdicts. */
export function createMockNotify(): NotifyIpc & { shown: NotifyRequest[]; prefs: () => NotifyPrefs; badgeCount: () => number; setFocused: (f: boolean) => void } {
  let prefs: NotifyPrefs = { enabled: true, permission: true, question: true, finished: true, error: true, throttleMs: 10_000, burst: 12, sound: false };
  let focused = false;
  let badge = 0;
  const last = new Map<string, number>();
  const recent: number[] = [];
  const shown: NotifyRequest[] = [];
  return {
    shown,
    prefs: () => prefs,
    badgeCount: () => badge,
    setFocused: (f) => (focused = f),
    async configure(p) {
      prefs = p;
    },
    async show(req): Promise<NotifyVerdict> {
      if (!prefs.enabled || !prefs[req.kind as NotifyKind]) return "disabled";
      if (focused) return "focused";
      const now = Date.now();
      const key = `${req.kind}\u0000${req.runId ?? ""}`;
      const t = last.get(key);
      if (t !== undefined && now - t < prefs.throttleMs) return "throttled";
      while (recent.length && now - recent[0] >= 60_000) recent.shift();
      if (prefs.burst > 0 && recent.length >= prefs.burst) return "flooded";
      last.set(key, now);
      recent.push(now);
      shown.push(req);
      return "show";
    },
    async badge(runs) {
      badge = runs;
    },
  };
}
