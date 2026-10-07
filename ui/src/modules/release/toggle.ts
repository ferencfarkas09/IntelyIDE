// The Settings toggle of this extra. The flag is mirrored in localStorage so `register()` can read it synchronously
// (no IPC at startup); settings.json (namespace "extras") is the durable copy the Settings section keeps in step.
import { createSignal } from "solid-js";
import { ipc } from "../../ipc";

const KEY = "intely.extra.release";

const read = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};

const [on, setOn] = createSignal(read());
/** Set once the user flips the switch: a slower read of settings.json must not undo that. */
let chosen = false;
export const releaseEnabled = on;

export function setReleaseEnabled(next: boolean): void {
  chosen = true;
  setOn(next);
  try {
    localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    /* private window: the toggle still works for this run */
  }
  void ipc.settings.set("extras", { release: next }).catch(() => {});
}

/** Adopts the durable value when the mirror was empty or stale. Never throws. */
export async function syncReleaseEnabled(): Promise<void> {
  try {
    const v = (await ipc.settings.get("extras")).release;
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
