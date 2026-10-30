import { call, subscribe } from "./rpc";
import type { Unsubscribe } from "./index";

export interface TrayStatus {
  running: number;
  needsYou: number;
  /** "running", "paused" or empty/"idle". */
  timer: string;
  timerLabel: string;
  /** Share of the 5-hour plan window used (0-100), only when the person asked for it in the menu bar; absent or null = not shown. */
  planPercent?: number | null;
}

/** The menu-bar item (wave3 X3). The icon exists only while `configure({enabled: true})` is in force. Banners are `ipc.notify`. */
export interface TrayIpc {
  /** Resolves whether the icon exists afterwards. */
  configure(config: { enabled: boolean }): Promise<boolean>;
  update(status: TrayStatus): Promise<void>;
  /** A menu entry the UI handles: `new-run`, `stop-all`, and `needs-you` when the radar window could not be opened. */
  onAction(cb: (id: string) => void): Unsubscribe;
}

export function createTauriTray(): TrayIpc {
  return {
    configure: (config) => call("tray_configure", { config }),
    update: (status) => call("tray_update", { status }),
    onAction: (cb) => subscribe<{ id: string }>("tray:action", (e) => cb(e.id)),
  };
}
