// The Settings toggles of this extra. Mirrored in localStorage so `register()` reads them synchronously (no IPC at
// startup); settings.json (namespace "extras") is the durable copy the Settings section keeps in step.
import { createSignal } from "solid-js";
import { ipc } from "../../ipc";

function flag(key: string, name: string, fallback: boolean) {
  const read = (): boolean => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v === "1";
    } catch {
      return fallback;
    }
  };
  const [on, setOn] = createSignal(read());
  let chosen = false;
  const write = (next: boolean) => {
    try {
      localStorage.setItem(key, next ? "1" : "0");
    } catch {
      /* private window: the toggle still works for this run */
    }
  };
  return {
    on,
    set(next: boolean): void {
      chosen = true;
      setOn(next);
      write(next);
      void ipc.settings.set("extras", { [name]: next }).catch(() => {});
    },
    async sync(): Promise<void> {
      try {
        const v = (await ipc.settings.get("extras"))[name];
        if (!chosen && typeof v === "boolean" && v !== on()) {
          setOn(v);
          write(v);
        }
      } catch {
        /* settings unavailable: keep the mirror */
      }
    },
  };
}

const hygiene = flag("intely.extra.hygiene", "hygiene", false);

export const hygieneEnabled = hygiene.on;
export const setHygieneEnabled = hygiene.set;
export const syncHygieneEnabled = hygiene.sync;
