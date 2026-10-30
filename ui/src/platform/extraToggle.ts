// The on/off switch of a lazy extra. Mirrored in localStorage so a module's `register()` reads it synchronously (no IPC at
// startup); settings.json (namespace "extras") is the durable copy the Settings section keeps in step. A flip by the person
// wins over a slower read of settings.json.
import { createSignal, type Accessor } from "solid-js";
import { ipc } from "../ipc";

export interface ExtraToggle {
  on: Accessor<boolean>;
  set(next: boolean): void;
  /** Adopts the durable value when the mirror was empty or stale. Never throws. */
  sync(): Promise<void>;
}

export function createExtraToggle(storageKey: string, name: string, fallback: boolean): ExtraToggle {
  const read = (): boolean => {
    try {
      const v = localStorage.getItem(storageKey);
      return v === null ? fallback : v === "1";
    } catch {
      return fallback;
    }
  };
  const write = (next: boolean) => {
    try {
      localStorage.setItem(storageKey, next ? "1" : "0");
    } catch {
      /* private window: the toggle still works for this run */
    }
  };
  const [on, setOn] = createSignal(read());
  let chosen = false;
  return {
    on,
    set(next) {
      chosen = true;
      setOn(next);
      write(next);
      void ipc.settings.set("extras", { [name]: next }).catch(() => {});
    },
    async sync() {
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
