// The Settings toggle of the run picker (model, effort and ultracode in New run). It starts switched on: an untouched picker sends
// nothing, so a run starts exactly as before. The flag is mirrored in localStorage so `register()` and the dialog can read it
// synchronously; settings.json (namespace "extras") is the durable copy the Settings section keeps in step.
import { createSignal } from "solid-js";
import { ipc } from "../../ipc";

const KEY = "intely.extra.runPicker";

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
export const runPickerEnabled = on;

export function setRunPickerEnabled(next: boolean): void {
  chosen = true;
  setOn(next);
  try {
    localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    /* private window: the toggle still works for this run */
  }
  void ipc.settings.set("extras", { runPicker: next }).catch(() => {});
}

/** Adopts the durable value when the mirror was empty or stale. Never throws. */
export async function syncRunPickerEnabled(): Promise<void> {
  try {
    const v = (await ipc.settings.get("extras")).runPicker;
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
