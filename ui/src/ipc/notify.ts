import { call } from "./rpc";

export type NotifyKind = "permission" | "question" | "finished" | "error";

/** What the Rust gate applies (the UI saves the settings and sends them here whenever they change). */
export interface NotifyPrefs {
  /** The master switch. */
  enabled: boolean;
  permission: boolean;
  question: boolean;
  finished: boolean;
  error: boolean;
  /** Minimum gap between two banners of the same kind for the same run. */
  throttleMs: number;
  /** Most banners per minute over all runs; 0 = no limit. */
  burst: number;
  sound: boolean;
}

export type NotifyVerdict = "show" | "focused" | "disabled" | "throttled" | "flooded";

export interface NotifyRequest {
  kind: NotifyKind;
  title: string;
  body: string;
  /** The run it is about: the throttle is per kind and run. */
  runId?: string;
  /** Shown under the heading: the title of the run. */
  subtitle?: string;
}

/** Desktop banners and the Dock badge for agent runs. */
export interface NotifyIpc {
  configure(prefs: NotifyPrefs): Promise<void>;
  /** Shown only when the kind is on, the throttle and the burst cap allow it and the window is not focused. */
  show(req: NotifyRequest): Promise<NotifyVerdict>;
  /** The number of runs that wait for you; it is added to the count of Happy on the Dock icon. */
  badge(runs: number): Promise<void>;
}

export function createTauriNotify(): NotifyIpc {
  return {
    configure: (prefs) => call("notify_configure", { prefs }),
    show: (req) => call("notify_show", { req }),
    badge: (runs) => call("notify_badge", { runs }),
  };
}
