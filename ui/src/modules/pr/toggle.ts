// The Settings toggle of this extra. Mirrored in localStorage so `register()` reads it synchronously (no IPC at startup);
// settings.json (namespace "extras") is the durable copy the Settings section keeps in step.
import { createSignal } from "solid-js";
import { ipc } from "../../ipc";

const KEY = "intely.extra.pr";
const read = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};
const [on, setOn] = createSignal(read());
let chosen = false;
const write = (next: boolean) => {
  try {
    localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    /* private window: the toggle still works for this run */
  }
};

export const prEnabled = on;
export function setPrEnabled(next: boolean): void {
  chosen = true;
  setOn(next);
  write(next);
  void ipc.settings.set("extras", { pr: next }).catch(() => {});
}
export async function syncPrEnabled(): Promise<void> {
  try {
    const v = (await ipc.settings.get("extras")).pr;
    if (!chosen && typeof v === "boolean" && v !== on()) {
      setOn(v);
      write(v);
    }
  } catch {
    /* settings unavailable: keep the mirror */
  }
}
