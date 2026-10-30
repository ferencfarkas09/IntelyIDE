// State of "Auto-test after a run": the test results and the open "run tests?" questions, keyed by run id, and the
// preferences (settings.json namespace "autotest": `mode` and the remembered answer of each repository).
import { createRoot, createSignal } from "solid-js";
import { ipc } from "../../ipc";
import type { AutotestMode, AutotestPrefs, RepoAnswer, RepoTest } from "./types";

export const AUTOTEST_NS = "autotest";
export const DEFAULT_PREFS: AutotestPrefs = { mode: "ask", repos: {} };

const state = createRoot(() => {
  const [results, setResults] = createSignal<Record<string, Record<string, RepoTest>>>({});
  const [asks, setAsks] = createSignal<Record<string, string[]>>({});
  const [prefs, setPrefs] = createSignal<AutotestPrefs>(DEFAULT_PREFS);
  return { results, setResults, asks, setAsks, prefs, setPrefs };
});

/** Every repository result of one run (insertion order). */
export const runResults = (runId: string): RepoTest[] => Object.values(state.results()[runId] ?? {});
export const repoResult = (runId: string, repoId: string): RepoTest | undefined => state.results()[runId]?.[repoId];

export function setRepoResult(runId: string, test: RepoTest): void {
  state.setResults((all) => ({ ...all, [runId]: { ...all[runId], [test.repoId]: test } }));
}

/** Forgets one repository's result of a run (a held test dropped when the extra is switched off). */
export function dropRepoResult(runId: string, repoId: string): void {
  state.setResults((all) => {
    if (!all[runId]?.[repoId]) return all;
    const { [repoId]: _gone, ...rest } = all[runId];
    const next = { ...all, [runId]: rest };
    if (!Object.keys(rest).length) delete next[runId];
    return next;
  });
}

/** The repositories of a run whose answer is still open (the "run tests?" card). */
export const runAsk = (runId: string): string[] => state.asks()[runId] ?? [];

export function setRunAsk(runId: string, repoIds: string[]): void {
  state.setAsks((all) => {
    const next = { ...all };
    if (repoIds.length) next[runId] = repoIds;
    else delete next[runId];
    return next;
  });
}

export const prefs = state.prefs;

export function parsePrefs(raw: Record<string, unknown> | undefined): AutotestPrefs {
  const mode = raw?.mode === "off" || raw?.mode === "always" || raw?.mode === "ask" ? (raw.mode as AutotestMode) : DEFAULT_PREFS.mode;
  const repos: Record<string, RepoAnswer> = {};
  const src = raw?.repos;
  if (src && typeof src === "object") for (const [k, v] of Object.entries(src as Record<string, unknown>)) if (v === "yes" || v === "no") repos[k] = v;
  return { mode, repos };
}

/** Reads settings.json once; a failure keeps the defaults. */
export async function loadPrefs(): Promise<AutotestPrefs> {
  try {
    state.setPrefs(parsePrefs(await ipc.settings.get(AUTOTEST_NS)));
  } catch {
    /* settings unavailable: defaults */
  }
  return state.prefs();
}

const save = (patch: Record<string, unknown>) => void ipc.settings.set(AUTOTEST_NS, patch).catch(() => {});

export function setMode(mode: AutotestMode): void {
  state.setPrefs((p) => ({ ...p, mode }));
  save({ mode });
}

export function rememberAnswer(repoIds: string[], answer: RepoAnswer): void {
  const repos = { ...state.prefs().repos };
  for (const id of repoIds) repos[id] = answer;
  state.setPrefs((p) => ({ ...p, repos }));
  save({ repos });
}

export function forgetAnswers(): void {
  state.setPrefs((p) => ({ ...p, repos: {} }));
  save({ repos: null });
}

/** Tests only. */
export function resetAutotestStore(p: AutotestPrefs = DEFAULT_PREFS): void {
  state.setResults({});
  state.setAsks({});
  state.setPrefs(p);
}
