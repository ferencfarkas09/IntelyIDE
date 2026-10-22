import { createSignal } from "solid-js";
import { ipc } from "../../ipc";

/** The `intelyfix` namespace of settings.json: how IntelyFIX hands an issue to an agent. Preferences only, no secrets (the token is Sentry's). */
const NS = "intelyfix";

/** Who an issue is given to when Fix is pressed. */
export type FixAssignee = { mode: "me" } | { mode: "none" } | { mode: "pick"; kind: "user" | "team"; id: string; name: string };

export interface FixPrefs {
  assignee: FixAssignee;
  /** The role the fix run starts with. */
  role: string;
  /** The mode it works in: Accept edits (`edit`) or Ask before each change (`ask`). */
  permission: "edit" | "ask";
  /** `now`: Fix starts the run. `review`: Fix opens the New run dialog filled in, and the run starts when you press Start run. */
  start: "now" | "review";
  /** The prompt template; empty means the built-in one. */
  template: string;
  /** Sentry project slug -> repository names of this workspace; the first is where the work is, the others may change with it. */
  repoMap: Record<string, string[]>;
}

export const DEFAULT_PREFS: FixPrefs = { assignee: { mode: "me" }, role: "developer", permission: "edit", start: "now", template: "", repoMap: {} };

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function parsePrefs(raw: Record<string, unknown> | undefined): FixPrefs {
  const a = raw?.assignee as Record<string, unknown> | undefined;
  let assignee: FixAssignee = DEFAULT_PREFS.assignee;
  if (a?.mode === "none") assignee = { mode: "none" };
  else if (a?.mode === "pick" && (a.kind === "user" || a.kind === "team") && /^\d{1,20}$/.test(text(a.id))) assignee = { mode: "pick", kind: a.kind, id: text(a.id), name: text(a.name) || text(a.id) };
  const map: Record<string, string[]> = {};
  if (raw?.repoMap && typeof raw.repoMap === "object") {
    for (const [project, value] of Object.entries(raw.repoMap as Record<string, unknown>)) {
      const names = (Array.isArray(value) ? value : [value]).map(text).filter(Boolean);
      if (project.trim() && names.length) map[project.trim()] = [...new Set(names)];
    }
  }
  return {
    assignee,
    role: text(raw?.role) || DEFAULT_PREFS.role,
    permission: raw?.permission === "ask" ? "ask" : "edit",
    start: raw?.start === "review" ? "review" : "now",
    template: typeof raw?.template === "string" ? raw.template : "",
    repoMap: map,
  };
}

const [prefs, setPrefs] = createSignal<FixPrefs>(DEFAULT_PREFS);
export const fixPrefs = prefs;

let ready: Promise<void> | undefined;

/**
 * Reads the preferences once and follows later changes. Called when the tab or the settings section is first shown; the promise is
 * what a Fix waits for, so a click right after the start never runs on the defaults while the saved choice is still on its way.
 */
export function loadFixPrefs(): Promise<void> {
  if (ready) return ready;
  ipc.settings.onChange((e) => e.ns === NS && setPrefs(parsePrefs(e.value)));
  return (ready = ipc.settings.get(NS).then(
    (raw) => void setPrefs(parsePrefs(raw)),
    () => {},
  ));
}

export async function saveFixPrefs(patch: Partial<FixPrefs>): Promise<void> {
  const next = { ...prefs(), ...patch };
  setPrefs(next);
  await ipc.settings.set(NS, { assignee: next.assignee, role: next.role, permission: next.permission, start: next.start, template: next.template, repoMap: next.repoMap });
}

/** Tests only: back to the defaults, as if the settings had never been read. */
export function resetFixPrefs(): void {
  ready = undefined;
  setPrefs(DEFAULT_PREFS);
}
