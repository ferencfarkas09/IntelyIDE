import { t } from "../../i18n";
import type { NotifyKind, NotifyPrefs } from "../../ipc/notify";

export const THROTTLE_SECONDS = [5, 10, 30, 60] as const;
/** At most this many banners per minute over all runs (ten agents on three servers must not bury the desktop). */
export const BURST = 12;
/** A state counts only when it lasts: a request that a saved rule answers within a moment never needed you. */
export const SETTLE_MS = 1200;
/** A window focus within this time of a banner is taken as the click on it. */
export const CLICK_WINDOW_MS = 90_000;

export interface NotifySettings {
  enabled: boolean;
  permission: boolean;
  question: boolean;
  finished: boolean;
  error: boolean;
  /** The number of runs that wait for you on the Dock icon. */
  badge: boolean;
  sound: boolean;
  throttleSeconds: number;
}

export const DEFAULT_NOTIFY: NotifySettings = { enabled: true, permission: true, question: true, finished: true, error: true, badge: true, sound: false, throttleSeconds: 10 };

export function readNotify(v: Record<string, unknown> | undefined): NotifySettings {
  const flag = (k: Exclude<keyof NotifySettings, "throttleSeconds">) => (typeof v?.[k] === "boolean" ? (v[k] as boolean) : DEFAULT_NOTIFY[k]);
  const sec = typeof v?.throttleSeconds === "number" && v.throttleSeconds >= 1 && v.throttleSeconds <= 3600 ? Math.round(v.throttleSeconds) : DEFAULT_NOTIFY.throttleSeconds;
  return { enabled: flag("enabled"), permission: flag("permission"), question: flag("question"), finished: flag("finished"), error: flag("error"), badge: flag("badge"), sound: flag("sound"), throttleSeconds: sec };
}

export function toPrefs(s: NotifySettings): NotifyPrefs {
  return { enabled: s.enabled, permission: s.permission, question: s.question, finished: s.finished, error: s.error, throttleMs: s.throttleSeconds * 1000, burst: BURST, sound: s.sound };
}

export interface Transition {
  kind: NotifyKind;
  /** The heading of the banner. */
  title: string;
  /** A fixed sentence: never command text or file content. */
  body: string;
}

/** What a run's change of state is worth a banner for. `needs` carries the kind of the pending request. */
export function transitionOf(prev: string | undefined, next: string, needs?: "permission" | "question"): Transition | undefined {
  if (prev === undefined || prev === next) return undefined;
  if (next === "needsYou") return needs === "question" ? { kind: "question", title: t("hud.notify.question"), body: t("notify.body.question") } : { kind: "permission", title: t("hud.notify.permission"), body: t("notify.body.permission") };
  if (next === "done" && prev === "running") return { kind: "finished", title: t("hud.notify.finished"), body: t("notify.body.finished") };
  if (next === "error") return { kind: "error", title: t("hud.notify.failed"), body: t("notify.body.error") };
  return undefined;
}

export interface Shown {
  runId: string;
  at: number;
}

/** The run to bring forward when the window gets focus soon after a banner (the click on it), or nothing. */
export function runToShow(last: Shown | undefined, now: number, statusOf: (runId: string) => string | undefined): string | undefined {
  if (!last || now - last.at > CLICK_WINDOW_MS || now < last.at) return undefined;
  return statusOf(last.runId) === undefined ? undefined : last.runId;
}
