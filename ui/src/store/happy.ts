// Shared view of the Happy integrations for the three modules that use them (integrations, happy-timer, happy-meet);
// modules never import each other, so the state lives here. Docs/integrations-plan.md 1.5: nothing is subscribed, polled or
// fetched while the master switch or every provider switch is off.
import { createSignal } from "solid-js";
import { ipc } from "../ipc";
import type { HappyStatus, Meeting, MeetView, ProviderPrefs, ProviderState, TimerView } from "../ipc/happy";
import { startNtFeed, stopNtFeed } from "./happyNt";

export const IDLE_TIMER: TimerView = { phase: "idle", kind: "", targetId: "", title: "", startedAtMs: 0, accumulatedSec: 0, canBreak: false, offsetMs: 0, stale: false };
const NO_MEETINGS: MeetView = { meetings: [], stale: false };

/** A meeting is "imminent" from this long before its start. */
export const IMMINENT_MS = 15 * 60_000;

const [status, setStatus] = createSignal<HappyStatus>();
const [timer, setTimer] = createSignal<TimerView>(IDLE_TIMER);
const [meetings, setMeetings] = createSignal<MeetView>(NO_MEETINGS);
const [tick, setTick] = createSignal(Date.now());

export const happyStatus = status;
export const timerView = timer;
export const meetView = meetings;
/** Moves every 30 s while meetings are watched, so "starts in 5 min" can become true without a server event. */
export const meetClock = tick;

export type ProviderId = "timer" | "meet" | "chat";
export const providerState = (id: ProviderId): ProviderState | undefined => status()?.providers.find((p) => p.id === id)?.state;
/** The `chat` preferences; the generated `HappyConfig` only has them once R1's bindings are in. */
export const chatPrefs = (): ProviderPrefs | undefined => (status()?.config as { chat?: ProviderPrefs } | undefined)?.chat;
const running = (id: ProviderId) => {
  const s = providerState(id);
  return s === "ready" || s === "degraded";
};

export const timerChipVisible = (): boolean => !!status()?.config.master && !!status()?.config.timer.showInStatusBar && running("timer");
/** The persistent "session expired" banner: set after a 401 until a new token is saved. */
export const signedOutNotice = () => status()?.signedOut;

/** The meeting the status bar points at: a live one, else the first that starts within 15 minutes. */
export function relevantMeeting(view: MeetView, nowMs: number): Meeting | undefined {
  const live = view.meetings.find((m) => m.status === "live");
  if (live) return live;
  return view.meetings
    .filter((m) => m.status === "scheduled" && m.startMs != null && m.startMs - nowMs <= IMMINENT_MS && m.startMs - nowMs > -IMMINENT_MS)
    .sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0))[0];
}

export const meetItemVisible = (): boolean => !!status()?.config.master && !!status()?.config.meet.showInStatusBar && running("meet") && !!relevantMeeting(meetings(), tick());

/** Re-reads the status (asks the Keychain whether a token is saved). Settings calls it when it opens. */
export async function refreshHappyStatus(): Promise<HappyStatus> {
  const s = await ipc.happy.status();
  setStatus(s);
  return s;
}

/** Settings hands in what `setConfig`, `saveToken` or `disconnect` returned, so the watcher follows a switch at once. */
export function applyHappyStatus(s: HappyStatus): void {
  setStatus(s);
  follow?.(isOn(s.config as unknown as Record<string, unknown>));
}

let stop: (() => void) | undefined;
let follow: ((on: boolean) => void) | undefined;

const isOn = (cfg: Record<string, unknown>): boolean => {
  const on = (key: string) => (cfg[key] as { enabled?: boolean } | undefined)?.enabled === true;
  return cfg.master === true && (on("timer") || on("meet") || on("chat") || on("notifications") || on("tasks"));
};

/**
 * Starts watching: one cheap read of the settings (no Keychain), then, only while integrations are on, the backend events
 * and the first status. Returns a disposer. Calling it twice returns the first watcher's disposer.
 */
export function startHappyWatch(): () => void {
  if (stop) return stop;
  let live: (() => void) | undefined;
  let clock: ReturnType<typeof setInterval> | undefined;
  const swap = (on: boolean) => {
    if (on === !!live) return;
    if (!on) {
      live?.();
      live = undefined;
      clearInterval(clock);
      setStatus(undefined);
      setTimer(IDLE_TIMER);
      setMeetings(NO_MEETINGS);
      stopNtFeed();
      return;
    }
    const offs = [ipc.happy.onState(setStatus), ipc.happy.timer.onChange(setTimer), ipc.happy.meet.onChange(setMeetings)];
    live = () => offs.forEach((off) => off());
    clock = setInterval(() => setTick(Date.now()), 30_000);
    startNtFeed();
    void ipc.happy.status().then(setStatus, () => {});
    void ipc.happy.timer.current().then(setTimer, () => {});
    void ipc.happy.meet.current().then(setMeetings, () => {});
  };
  follow = swap;
  void ipc.settings.get("happy").then((cfg) => swap(isOn(cfg)), () => {});
  const offSettings = ipc.settings.onChange((e) => e.ns === "happy" && swap(isOn(e.value)));
  stop = () => {
    offSettings();
    swap(false);
    follow = stop = undefined;
  };
  return stop;
}
