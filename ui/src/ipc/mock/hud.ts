import type { HudIpc, HudSnapshot } from "../hud";
import type { Unsubscribe } from "../index";

const MB = 1024 * 1024;

const SNAPSHOT: HudSnapshot = {
  sidecarPid: 4102,
  totalBytes: 0,
  rows: [
    { pid: 4100, name: "intely-switch-ide", kind: "app", rssBytes: 168 * MB, canKill: false },
    { pid: 4180, name: "com.apple.WebKit.WebContent", kind: "webKit", rssBytes: 142 * MB, canKill: true },
    { pid: 4102, name: "node sidecar/dist/index.js", kind: "sidecar", rssBytes: 74 * MB, canKill: true },
    { pid: 4140, name: "claude", kind: "agent", rssBytes: 211 * MB, canKill: true },
    { pid: 4181, name: "com.apple.WebKit.Networking", kind: "webKit", rssBytes: 21 * MB, canKill: true },
    { pid: 4190, name: "rg", kind: "child", rssBytes: 6 * MB, canKill: true },
  ],
};

/** Deterministic HUD for the browser mock and tests. `focus(false)` arms a timer for the configured minutes, like the Rust clock. */
export function createMockHud(): HudIpc & { rows: () => HudSnapshot } {
  let snap: HudSnapshot = { ...SNAPSHOT, totalBytes: SNAPSHOT.rows.reduce((n, r) => n + r.rssBytes, 0) };
  let enabled = false;
  let afterMs = 5 * 60_000;
  let active = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<(a: boolean) => void>();
  const set = (a: boolean) => {
    if (a === active) return;
    active = a;
    listeners.forEach((l) => l(a));
  };
  const rebuild = (rows: HudSnapshot["rows"]) => (snap = { ...snap, rows, totalBytes: rows.reduce((n, r) => n + r.rssBytes, 0) });
  return {
    rows: () => snap,
    async snapshot() {
      return snap;
    },
    async kill(pid) {
      const row = snap.rows.find((r) => r.pid === pid);
      if (!row) throw { code: "notOurs", message: `process ${pid} is not part of the app` };
      if (!row.canKill) throw { code: "protected", message: "the app itself cannot be stopped from here" };
      rebuild(snap.rows.filter((r) => r.pid !== pid));
    },
    async restartSidecar() {
      if (!snap.rows.some((r) => r.kind === "sidecar")) return false;
      rebuild(snap.rows.filter((r) => r.kind !== "sidecar" && r.kind !== "agent"));
      return true;
    },
    async configure(e, minutes) {
      enabled = e;
      afterMs = Math.max(1, minutes) * 60_000;
      if (!e) {
        clearTimeout(timer);
        set(false);
      }
      return active;
    },
    async focus(focused) {
      clearTimeout(timer);
      if (focused) set(false);
      else if (enabled && !active) timer = setTimeout(() => set(true), afterMs);
      return active;
    },
    onEco(cb): Unsubscribe {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };
}
