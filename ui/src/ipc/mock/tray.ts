import type { TrayIpc, TrayStatus } from "../tray";

export function createMockTray(): TrayIpc & { status: () => TrayStatus; exists: () => boolean; click: (id: string) => void } {
  let exists = false;
  let status: TrayStatus = { running: 0, needsYou: 0, timer: "", timerLabel: "" };
  const listeners = new Set<(id: string) => void>();
  return {
    status: () => status,
    exists: () => exists,
    click: (id) => listeners.forEach((l) => l(id)),
    async configure(config) {
      exists = config.enabled;
      return exists;
    },
    async update(s) {
      status = s;
    },
    onAction(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };
}
