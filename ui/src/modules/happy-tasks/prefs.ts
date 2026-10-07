import { createSignal } from "solid-js";
import { ipc } from "../../ipc";
import { DEFAULT_BRANCH_TEMPLATE } from "./logic";

/** The `happyTasks` namespace of settings.json: webview-side preferences of the Tasks tab, no secrets. */
const NS = "happyTasks";

export interface TaskPrefs {
  /** `{key}`, `{id}`, `{slug}`, `{project}`; see `branchName`. */
  branchTemplate: string;
  /** Happy project name -> repository name in this workspace. */
  repoMap: Record<string, string>;
}

export const DEFAULT_PREFS: TaskPrefs = { branchTemplate: DEFAULT_BRANCH_TEMPLATE, repoMap: {} };

export function parsePrefs(raw: Record<string, unknown> | undefined): TaskPrefs {
  const template = typeof raw?.branchTemplate === "string" && raw.branchTemplate.trim() ? raw.branchTemplate : DEFAULT_PREFS.branchTemplate;
  const map = raw?.repoMap && typeof raw.repoMap === "object" ? Object.entries(raw.repoMap as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== "") : [];
  return { branchTemplate: template, repoMap: Object.fromEntries(map) };
}

const [prefs, setPrefs] = createSignal<TaskPrefs>(DEFAULT_PREFS);
export const taskPrefs = prefs;

let started = false;

/** Reads the preferences once and follows later changes. Called when the Tasks tab or its settings section is first shown. */
export function loadTaskPrefs(): void {
  if (started) return;
  started = true;
  void ipc.settings.get(NS).then((raw) => setPrefs(parsePrefs(raw)), () => {});
  ipc.settings.onChange((e) => e.ns === NS && setPrefs(parsePrefs(e.value)));
}

export async function saveTaskPrefs(patch: Partial<TaskPrefs>): Promise<void> {
  const next = { ...prefs(), ...patch };
  setPrefs(next);
  await ipc.settings.set(NS, { branchTemplate: next.branchTemplate, repoMap: next.repoMap });
}
