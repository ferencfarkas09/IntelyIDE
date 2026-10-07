import { call, subscribe } from "./rpc";
import type { Unsubscribe } from "./index";

export type ProcKind = "app" | "webKit" | "sidecar" | "agent" | "child";

export interface ProcRow {
  pid: number;
  name: string;
  kind: ProcKind;
  rssBytes: number;
  canKill: boolean;
}

export interface HudSnapshot {
  totalBytes: number;
  rows: ProcRow[];
  sidecarPid?: number | null;
}

/** Resource HUD and Eco mode (wave3 X3). Nothing runs until the UI calls `configure`; the snapshot is one `ps`, taken on demand. */
export interface HudIpc {
  snapshot(): Promise<HudSnapshot>;
  /** SIGTERM to one process of the app's own tree; the app itself and strangers are refused. */
  kill(pid: number): Promise<void>;
  /** Stops the sidecar; the next run starts a fresh one. Resolves false when none was running. */
  restartSidecar(): Promise<boolean>;
  /** Eco on or off and the unfocused minutes before it starts. Resolves whether Eco is active right now. */
  configure(enabled: boolean, afterMinutes: number): Promise<boolean>;
  /** The window focus, for the Rust-side Eco clock. */
  focus(focused: boolean): Promise<boolean>;
  onEco(cb: (active: boolean) => void): Unsubscribe;
}

export function createTauriHud(): HudIpc {
  return {
    snapshot: () => call("hud_snapshot"),
    kill: (pid) => call("hud_kill", { pid }),
    restartSidecar: () => call("hud_restart_sidecar"),
    configure: (enabled, afterMinutes) => call("hud_configure", { enabled, afterMinutes }),
    focus: (focused) => call("hud_focus", { focused }),
    onEco: (cb) => subscribe<{ active: boolean }>("hud:eco", (e) => cb(e.active)),
  };
}
