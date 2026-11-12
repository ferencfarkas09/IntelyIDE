// The plan usage for the menu bar, only while the person asked for it there: the usage store's reading is mirrored, and while
// nothing else reads it a quiet five-minute poll (paused in Eco mode) keeps it fresh. Reading the limits starts the Claude CLI
// for a moment, which is why this is off by default.
import { createEffect, createRoot, onCleanup } from "solid-js";
import { ecoInterval } from "../../platform/eco";
import { setTrayPlanPercent } from "../../store/planUsage";
import { usageApi } from "../usage/api";
import { limits } from "../usage/store";
import type { PlanLimits } from "../usage/types";
import { trayPlanEnabled } from "./toggle";

export const TRAY_POLL_MS = 5 * 60_000;

export const fiveHourPercent = (l: PlanLimits | undefined): number | null => (l && l.available && l.fiveHour ? l.fiveHour.utilization : null);

let lastRead = 0;
/** Bumped by each start and stop, so a reading that lands after the poll was stopped is dropped. */
let generation = 0;

async function poll(): Promise<void> {
  // The dashboard or the Usage tab read the limits recently: their value is already mirrored.
  if (Date.now() - lastRead < TRAY_POLL_MS - 1_000) return;
  lastRead = Date.now();
  const mine = generation;
  const value = fiveHourPercent(await usageApi().limits());
  if (mine === generation && trayPlanEnabled()) setTrayPlanPercent(value);
}

/** Starts the mirror and the poll while `trayPlanEnabled()`; returns the disposer, which also clears the menu bar reading. */
export function startPlanPoll(): () => void {
  generation += 1;
  return createRoot((dispose) => {
    createEffect(() => {
      if (!trayPlanEnabled()) return setTrayPlanPercent(null);
      const l = limits();
      if (l) {
        lastRead = Date.now();
        setTrayPlanPercent(fiveHourPercent(l));
      }
    });
    createEffect(() => {
      if (!trayPlanEnabled()) return;
      void poll().catch(() => {});
      onCleanup(ecoInterval(() => void poll().catch(() => {}), TRAY_POLL_MS));
    });
    return () => {
      generation += 1;
      dispose();
      setTrayPlanPercent(null);
    };
  });
}

/** Test helper. */
export const resetPlanPoll = (): void => void (lastRead = 0);
