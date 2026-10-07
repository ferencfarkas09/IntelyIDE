import { call, subscribe } from "./rpc";
import type { Unsubscribe } from "./index";

export type NotifyKind = "permission" | "question" | "finished" | "error";

export interface NotifyPrefs {
  permission: boolean;
  question: boolean;
  finished: boolean;
  error: boolean;
  throttleMs: number;
}

export interface TrayStatus {
  running: number;
  needsYou: number;
  /** "running", "paused" or empty/"idle". */
  timer: string;
  timerLabel: string;
}

export type NotifyVerdict = "show" | "focused" | "disabled" | "throttled";

/** Menu-bar item and native notifications (wave3 X3). The icon exists only while `configure({enabled: true})` is in force. */
export interface TrayIpc {
  /** Resolves whether the icon exists afterwards. */
  configure(config: { enabled: boolean; notify: NotifyPrefs }): Promise<boolean>;
  update(status: TrayStatus): Promise<void>;
  /** Shown only when the kind is on, the throttle allows it and the window is not focused. */
  notify(req: { kind: NotifyKind; title: string; body: string }): Promise<NotifyVerdict>;
  /** A menu entry the UI handles: `new-run`, `needs-you`, `stop-all`. */
  onAction(cb: (id: string) => void): Unsubscribe;
}

export function createTauriTray(): TrayIpc {
  return {
    configure: (config) => call("tray_configure", { config }),
    update: (status) => call("tray_update", { status }),
    notify: (req) => call("tray_notify", { req }),
    onAction: (cb) => subscribe<{ id: string }>("tray:action", (e) => cb(e.id)),
  };
}
