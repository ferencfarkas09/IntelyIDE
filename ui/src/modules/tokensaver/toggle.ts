// The Settings toggle of this extra. It starts switched on: it only adds buttons and lines to the context cockpit, and nothing
// is sent to a run unless the person presses a button (or switches "Nudge automatically" on). Mirrored in localStorage so
// `register()` reads it synchronously; settings.json (namespace "extras") is the durable copy the Settings section keeps in step.
import { createSignal } from "solid-js";
import { ipc } from "../../ipc";

const KEY = "intely.extra.tokenSaver";

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
export const tokenSaverEnabled = on;

export function setTokenSaverEnabled(next: boolean): void {
  chosen = true;
  setOn(next);
  try {
    localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    /* private window: the toggle still works for this run */
  }
  void ipc.settings.set("extras", { tokenSaver: next }).catch(() => {});
}

/** Adopts the durable value when the mirror was empty or stale. Never throws. */
export async function syncTokenSaverEnabled(): Promise<void> {
  try {
    const v = (await ipc.settings.get("extras")).tokenSaver;
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
