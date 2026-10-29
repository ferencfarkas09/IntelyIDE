// The person's prompts in settings.json (namespace `prompts`): their own for every repository, and per repository keyed by
// its id. Nothing is written into a repository. The placeholder values come from the editor and the repository state.
import { createSignal } from "solid-js";
import { ipc } from "../../ipc";
import { activeTab } from "../../platform/tabs";
import { snapshots } from "../../store/snapshots";
import { repoConfig, repos } from "../../store/workspace";
import { readSettings } from "./logic";
import type { PromptContext, PromptScope, PromptsSettings, SavedPrompt } from "./types";

const NS = "prompts";
const [settings, setSettings] = createSignal<PromptsSettings>({ user: [], repos: {} });
const [loaded, setLoaded] = createSignal(false);

export const promptSettings = settings;
export const promptsLoaded = loaded;

/** Reads the namespace once (again with `force`). A read failure leaves an empty library. */
export async function loadPrompts(force = false): Promise<PromptsSettings> {
  if (loaded() && !force) return settings();
  try {
    setSettings(readSettings(await ipc.settings.get(NS)));
  } catch {
    /* settings unavailable: the starters still work */
  }
  setLoaded(true);
  return settings();
}

/** The prompts of one scope (a starter scope has none of its own). */
export function promptsOf(scope: PromptScope, s = settings()): SavedPrompt[] {
  return scope.kind === "user" ? s.user : scope.kind === "repo" ? (s.repos[scope.repoId] ?? []) : [];
}

/** Writes one scope's list; the other scopes stay as they are. */
export async function savePrompts(scope: PromptScope, next: SavedPrompt[]): Promise<void> {
  if (scope.kind === "starter") return;
  const cur = settings();
  if (scope.kind === "user") {
    setSettings({ ...cur, user: next });
    await ipc.settings.set(NS, { user: next });
    return;
  }
  const reposNext = { ...cur.repos };
  if (next.length) reposNext[scope.repoId] = next;
  else delete reposNext[scope.repoId];
  setSettings({ ...cur, repos: reposNext });
  // `repos` is replaced as a whole (a shallow merge would keep a removed repository's list)
  await ipc.settings.set(NS, { repos: reposNext });
}

/** Test hook. */
export function resetPromptsStore(next: PromptsSettings = { user: [], repos: {} }): void {
  setSettings(next);
  setLoaded(false);
}

/** The repository the person is working in: the active file's, else the first of the workspace. */
export function currentRepo(): string | undefined {
  const tab = activeTab();
  const fromTab = tab?.type === "file" ? (tab.params?.repoId as string | undefined) : undefined;
  return fromTab ?? repos()[0]?.id;
}

/** The values for `{{selection}}`, `{{file}}`, `{{branch}}` and `{{repo}}` right now. */
export async function promptContext(repoId = currentRepo()): Promise<PromptContext> {
  const tab = activeTab();
  const ctx: PromptContext = {};
  if (tab?.type === "file") {
    const file = tab.params?.path;
    if (typeof file === "string" && (tab.params?.repoId as string | undefined) === repoId) ctx.file = file;
    try {
      const { viewOf } = await import("../editor/buffers");
      const view = viewOf(tab.id);
      const sel = view?.state.selection.main;
      if (view && sel && !sel.empty) ctx.selection = view.state.sliceDoc(sel.from, sel.to).slice(0, 12_000);
    } catch {
      /* no editor loaded */
    }
  }
  if (repoId) {
    ctx.repo = repoConfig(repoId)?.name;
    ctx.branch = snapshots()[repoId]?.head.branch ?? undefined;
  }
  return ctx;
}
