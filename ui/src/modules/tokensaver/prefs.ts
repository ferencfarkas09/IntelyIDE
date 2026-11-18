// The choices of the token saver. "Nudge automatically" and the context threshold live in settings.json (namespace
// "tokensaver", mirrored in localStorage for a synchronous first read); "Token-saving habits" is `agents.tokenHabits`, which
// the host reads at every Claude start (crates/settings/src/agents.rs). All of them start off, the threshold at 60%.
import { createSignal } from "solid-js";
import { ipc } from "../../ipc";

export const THRESHOLDS = [40, 50, 60, 70, 80, 90] as const;
export const DEFAULT_THRESHOLD = 60;
const KEY = "intely.tokenSaver";

interface Stored {
  autoNudge: boolean;
  threshold: number;
}

/** Anything that is not a known value falls back to the default: off, 60%. */
export function sanitize(v: unknown): Stored {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  const threshold = typeof o.threshold === "number" && (THRESHOLDS as readonly number[]).includes(o.threshold) ? o.threshold : DEFAULT_THRESHOLD;
  return { autoNudge: o.autoNudge === true, threshold };
}

const read = (): Stored => {
  try {
    return sanitize(JSON.parse(localStorage.getItem(KEY) ?? "{}"));
  } catch {
    return sanitize({});
  }
};

const [prefs, setPrefs] = createSignal<Stored>(read());
const [habits, setHabitsSignal] = createSignal(false);
let chosen = false;

export const autoNudge = (): boolean => prefs().autoNudge;
export const threshold = (): number => prefs().threshold;
export const tokenHabits = habits;

function save(next: Stored): void {
  chosen = true;
  setPrefs(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private window */
  }
  void ipc.settings.set("tokensaver", { ...next }).catch(() => {});
}

export const setAutoNudge = (on: boolean): void => save({ ...prefs(), autoNudge: on });
export const setThreshold = (n: number): void => save(sanitize({ ...prefs(), threshold: n }));

export function setTokenHabits(on: boolean): void {
  setHabitsSignal(on);
  void ipc.settings.set("agents", { tokenHabits: on }).catch(() => {});
}

/** Reads settings.json once (the Settings section and the Project notes view call it). Never throws. */
export async function syncPrefs(): Promise<void> {
  try {
    const [saver, agents] = await Promise.all([ipc.settings.get("tokensaver"), ipc.settings.get("agents")]);
    if (!chosen) {
      const next = sanitize(saver);
      setPrefs(next);
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
    }
    setHabitsSignal(agents.tokenHabits === true);
  } catch {
    /* settings unavailable: keep what we have */
  }
}

/** Test helper. */
export function resetPrefs(): void {
  chosen = false;
  setPrefs(sanitize({}));
  setHabitsSignal(false);
}
