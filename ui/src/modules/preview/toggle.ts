// The Settings switch of the component preview. Mirrored in localStorage so `register()` reads it synchronously (no IPC at
// startup); settings.json (namespace "extras", key "previewComponent") is the durable copy the Settings section keeps in step.
// On by default: it only adds a tab type and palette commands, and loads no code until a component is previewed.
import { createSignal } from "solid-js";
import { ipc } from "../../ipc";

const KEY = "intely.extra.previewComponent";
const NAME = "previewComponent";

const read = (): boolean => {
  try {
    const v = localStorage.getItem(KEY);
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
};
const write = (next: boolean) => {
  try {
    localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    /* private window: the toggle still works for this run */
  }
};

const [on, setOn] = createSignal(read());
let chosen = false;

export const componentPreviewEnabled = on;

export function setComponentPreviewEnabled(next: boolean): void {
  chosen = true;
  setOn(next);
  write(next);
  void ipc.settings.set("extras", { [NAME]: next }).catch(() => {});
}

export async function syncComponentPreviewEnabled(): Promise<void> {
  try {
    const v = (await ipc.settings.get("extras"))[NAME];
    if (!chosen && typeof v === "boolean" && v !== on()) {
      setOn(v);
      write(v);
    }
  } catch {
    /* settings unavailable: keep the mirror */
  }
}
