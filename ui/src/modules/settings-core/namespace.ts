import { createSignal, onCleanup, type Accessor } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { errorText } from "../../store/snapshots";
import { toast } from "../../ui-kit";
import type { SettingsValue } from "../../ipc/settings";

export interface SettingsNamespace<T> {
  value: Accessor<T>;
  /** False until the first read of settings.json answered. */
  ready: Accessor<boolean>;
  /** Applies the patch at once, then writes it; a refused write rolls back and tells the user. */
  update(patch: Partial<T>): Promise<void>;
}

/** Reactive view of one settings.json namespace. Call inside a component: it listens for changes until the component is gone. */
export function useNamespace<T extends object>(ns: string, normalize: (raw: SettingsValue) => T, after?: (next: T, raw: SettingsValue) => void): SettingsNamespace<T> {
  const [value, setValue] = createSignal<T>(normalize({}));
  const [ready, setReady] = createSignal(false);
  /** What settings.json holds, before defaults: a key that is absent has not been chosen yet. */
  let stored: SettingsValue = {};
  const take = (raw: SettingsValue) => {
    stored = raw;
    const next = normalize(raw);
    setValue(() => next);
    after?.(next, raw);
  };
  void ipc.settings
    .get(ns)
    .then(take)
    .catch(() => {})
    .finally(() => setReady(true));
  onCleanup(ipc.settings.onChange((e) => e.ns === ns && take(e.value)));

  return {
    value,
    ready,
    async update(patch) {
      const before = stored;
      take({ ...before, ...patch } as SettingsValue);
      try {
        await ipc.settings.set(ns, patch as SettingsValue);
      } catch (e) {
        take(before);
        toast.error(t("settings.saveFailed"), errorText(e));
      }
    },
  };
}
