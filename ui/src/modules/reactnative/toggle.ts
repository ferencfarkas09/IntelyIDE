// The Settings toggle of this extra. It starts switched on, but the panel only shows up where a React Native or Expo project
// is detected, so a workspace without one never sees it. The flag is mirrored in localStorage so `register()` can read it
// synchronously; settings.json (namespace "extras") is the durable copy the Settings section keeps in step.
import { createSignal } from "solid-js";
import { ipc } from "../../ipc";

const KEY = "intely.extra.reactnative";

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
export const reactNativeEnabled = on;

export function setReactNativeEnabled(next: boolean): void {
  chosen = true;
  setOn(next);
  try {
    localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    /* private window: the toggle still works for this run */
  }
  void ipc.settings.set("extras", { reactnative: next }).catch(() => {});
}

/** Adopts the durable value when the mirror was empty or stale. Never throws. */
export async function syncReactNativeEnabled(): Promise<void> {
  try {
    const v = (await ipc.settings.get("extras")).reactnative;
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
