// Saved state per component (props text, store, providers, viewport, saved prop sets), in settings.json namespace `preview`
// under `component:<repoId>:<path>#<export>`. Tabs remount, so nothing lives in a component.
import { createSignal } from "solid-js";
import { ipc } from "../../ipc";
import { defaultPrefs, parsePrefs, type ComponentPrefs } from "./componentLogic";

const NS = "preview";
const SAVE_DELAY_MS = 400;

const [all, setAll] = createSignal<Record<string, ComponentPrefs>>({});
const loading = new Map<string, Promise<void>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export const prefsOf = (key: string): ComponentPrefs => all()[key] ?? defaultPrefs();

export function loadPrefs(key: string): Promise<void> {
  const have = loading.get(key);
  if (have) return have;
  const p: Promise<void> = ipc.settings
    .get(NS)
    .then((v) => void setAll((a) => (key in a ? a : { ...a, [key]: parsePrefs(v[key]) })))
    .catch(() => void setAll((a) => (key in a ? a : { ...a, [key]: defaultPrefs() })));
  loading.set(key, p);
  return p;
}

async function save(key: string): Promise<void> {
  timers.delete(key);
  try {
    await ipc.settings.set(NS, { [key]: all()[key] });
  } catch {
    // a read-only settings file only costs the persistence; the session state stays
  }
}

export function patchPrefs(key: string, patch: Partial<ComponentPrefs>): void {
  setAll((a) => ({ ...a, [key]: { ...(a[key] ?? defaultPrefs()), ...patch } }));
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => void save(key), SAVE_DELAY_MS));
}

export async function flushPrefs(): Promise<void> {
  const keys = [...timers.keys()];
  keys.forEach((k) => clearTimeout(timers.get(k)));
  await Promise.all(keys.map(save));
}

/** Test helper. */
export function resetComponentState(): void {
  timers.forEach((t) => clearTimeout(t));
  timers.clear();
  loading.clear();
  setAll({});
}
