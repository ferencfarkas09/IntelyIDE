// The Settings toggle of this extra. It starts switched on (every tool only reads, and a tool shows up only where its files exist).
// The flag is mirrored in localStorage so `register()` can read it synchronously (no IPC at startup); settings.json
// (namespace "extras") is the durable copy the Settings section keeps in step.
import { createSignal } from "solid-js";
import { ipc } from "../../ipc";

const KEY = "intely.extra.webtools";

const read = (): boolean => {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
};

const [on, setOn] = createSignal(read());
/** Set once the user flips the switch: a slower read of settings.json must not undo that. */
let chosen = false;
export const webtoolsEnabled = on;

export function setWebtoolsEnabled(next: boolean): void {
  chosen = true;
  setOn(next);
  try {
    localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    /* private window: the toggle still works for this run */
  }
  void ipc.settings.set("extras", { webtools: next }).catch(() => {});
}

/** Adopts the durable value when the mirror was empty or stale. Never throws. */
export async function syncWebtoolsEnabled(): Promise<void> {
  try {
    const v = (await ipc.settings.get("extras")).webtools;
    if (!chosen && typeof v === "boolean" && v !== on()) {
      setOn(v);
      try {
        localStorage.setItem(KEY, v ? "1" : "0");
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* settings unavailable: keep the mirror */
  }
}
