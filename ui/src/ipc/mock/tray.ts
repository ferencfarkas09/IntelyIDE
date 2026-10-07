import type { NotifyKind, NotifyPrefs, NotifyVerdict, TrayIpc, TrayStatus } from "../tray";

/** Mirrors the Rust gate (per-kind switch, per-kind throttle, never while focused) so UI tests see the same verdicts. */
export function createMockTray(): TrayIpc & { shown: { kind: NotifyKind; title: string; body: string }[]; status: () => TrayStatus; exists: () => boolean; click: (id: string) => void; setFocused: (f: boolean) => void } {
  let prefs: NotifyPrefs = { permission: true, question: true, finished: true, error: true, throttleMs: 10_000 };
  let exists = false;
  let focused = false;
  let status: TrayStatus = { running: 0, needsYou: 0, timer: "", timerLabel: "" };
  const last = new Map<NotifyKind, number>();
  const shown: { kind: NotifyKind; title: string; body: string }[] = [];
  const listeners = new Set<(id: string) => void>();
  return {
    shown,
    status: () => status,
    exists: () => exists,
    click: (id) => listeners.forEach((l) => l(id)),
    setFocused: (f) => (focused = f),
    async configure(config) {
      prefs = config.notify;
      exists = config.enabled;
      return exists;
    },
    async update(s) {
      status = s;
    },
    async notify(req): Promise<NotifyVerdict> {
      if (!prefs[req.kind]) return "disabled";
      if (focused) return "focused";
      const now = Date.now();
      const t = last.get(req.kind);
      if (t !== undefined && now - t < prefs.throttleMs) return "throttled";
      last.set(req.kind, now);
      shown.push(req);
      return "show";
    },
    onAction(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };
}
