import { createSignal } from "solid-js";

/**
 * The share of the 5-hour plan window used, 0 to 100, as the dashboard's poller last read it; null while unknown or while the
 * person has not asked for it in the menu bar. Shared state so the HUD's tray bridge can show it without importing the dashboard.
 */
const [percent, setPercent] = createSignal<number | null>(null);
export const trayPlanPercent = percent;

export function setTrayPlanPercent(next: number | null): void {
  setPercent(next === null || !Number.isFinite(next) ? null : Math.round(Math.min(100, Math.max(0, next))));
}
