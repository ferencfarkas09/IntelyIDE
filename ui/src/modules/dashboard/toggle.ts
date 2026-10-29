// The Settings toggle of this extra and the two preferences beside it. The dashboard starts switched on (it only reads what other
// features already know); the flag is mirrored in localStorage so `register()` reads it synchronously, and settings.json (namespace
// "extras") is the durable copy. "Show the dashboard at start" and "Plan usage in the menu bar" live in the namespace "widgets",
// next to the layout, with the same mirror.
import { createSignal } from "solid-js";
import { ipc } from "../../ipc";
import { SETTINGS_NS } from "../../platform/widgets";
import { readStored, writeStored } from "../../ui-kit/storage";

const KEY = "intely.extra.dashboard";
const START_KEY = "intely.dashboard.atStart";
const TRAY_KEY = "intely.dashboard.trayPlan";

const flag = (key: string, fallback: boolean): boolean => {
  const v = readStored(key);
  return v === null ? fallback : v !== "0";
};

const [on, setOn] = createSignal(flag(KEY, true));
const [atStart, setAtStart] = createSignal(flag(START_KEY, true));
const [trayPlan, setTrayPlan] = createSignal(flag(TRAY_KEY, false));
/** Set once the user flips a switch: a slower read of settings.json must not undo that. */
const chosen = new Set<string>();

export const dashboardEnabled = on;
/** Open the dashboard as the first tab when a workspace opens (default on). */
export const dashboardAtStart = atStart;
/** Show the 5-hour plan usage next to the counts in the menu bar (default off: reading it starts the Claude CLI). */
export const trayPlanEnabled = trayPlan;

export function setDashboardEnabled(next: boolean): void {
  chosen.add(KEY);
  setOn(next);
  writeStored(KEY, next ? "1" : "0");
  void ipc.settings.set("extras", { dashboard: next }).catch(() => {});
}

export function setDashboardAtStart(next: boolean): void {
  chosen.add(START_KEY);
  setAtStart(next);
  writeStored(START_KEY, next ? "1" : "0");
  void ipc.settings.set(SETTINGS_NS, { showAtStart: next }).catch(() => {});
}

export function setTrayPlanEnabled(next: boolean): void {
  chosen.add(TRAY_KEY);
  setTrayPlan(next);
  writeStored(TRAY_KEY, next ? "1" : "0");
  void ipc.settings.set(SETTINGS_NS, { trayPlan: next }).catch(() => {});
}

/** Adopts the durable values when the mirror was empty or stale. Never throws. */
export async function syncDashboardPrefs(): Promise<void> {
  const adopt = (key: string, v: unknown, current: () => boolean, set: (b: boolean) => void) => {
    if (chosen.has(key) || typeof v !== "boolean" || v === current()) return;
    set(v);
    writeStored(key, v ? "1" : "0");
  };
  try {
    const [extras, prefs] = await Promise.all([ipc.settings.get("extras"), ipc.settings.get(SETTINGS_NS)]);
    adopt(KEY, extras.dashboard, on, setOn);
    adopt(START_KEY, prefs.showAtStart, atStart, setAtStart);
    adopt(TRAY_KEY, prefs.trayPlan, trayPlan, setTrayPlan);
  } catch {
    /* settings unavailable: keep the mirror */
  }
}

/** Test helper. */
export function resetDashboardPrefs(): void {
  chosen.clear();
  setOn(true);
  setAtStart(true);
  setTrayPlan(false);
}
