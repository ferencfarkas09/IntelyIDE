// State of "Auto-test after a run": the test results and the open trust questions, keyed by run id, and the preferences
// (settings.json namespace "autotest": `mode`, the remembered answer of each repository and the fingerprint of the test
// command each repository was trusted with).
import { createRoot, createSignal } from "solid-js";
import { ipc } from "../../ipc";
import type { AskItem, AutotestMode, AutotestPrefs, RepoAnswer, RepoTest } from "./types";

export const AUTOTEST_NS = "autotest";
export const DEFAULT_PREFS: AutotestPrefs = { mode: "ask", repos: {}, trusted: {} };

const state = createRoot(() => {
  const [results, setResults] = createSignal<Record<string, Record<string, RepoTest>>>({});
  const [asks, setAsks] = createSignal<Record<string, AskItem[]>>({});
  const [prefs, setPrefs] = createSignal<AutotestPrefs>(DEFAULT_PREFS);
  return { results, setResults, asks, setAsks, prefs, setPrefs };
});

/** Every repository result of one run (insertion order). */
export const runResults = (runId: string): RepoTest[] => Object.values(state.results()[runId] ?? {});
export const repoResult = (runId: string, repoId: string): RepoTest | undefined => state.results()[runId]?.[repoId];

export function setRepoResult(runId: string, test: RepoTest): void {
  state.setResults((all) => ({ ...all, [runId]: { ...all[runId], [test.repoId]: test } }));
}

/** The repositories of a run whose answer is still open (the trust card), with the command each would run. */
export const runAsk = (runId: string): AskItem[] => state.asks()[runId] ?? [];

export function setRunAsk(runId: string, items: AskItem[]): void {
  state.setAsks((all) => {
    const next = { ...all };
    if (items.length) next[runId] = items;
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
  // Trust is never implied: only a fingerprint stored by the trust question counts (a "yes" of 1.14.0 does not).
  const trusted: Record<string, string> = {};
  const tr = raw?.trusted;
  if (tr && typeof tr === "object") for (const [k, v] of Object.entries(tr as Record<string, unknown>)) if (typeof v === "string" && /^[0-9a-f]{16}$/.test(v)) trusted[k] = v;
  return { mode, repos, trusted };
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

/** The answer of the trust question: Yes trusts each repository with the command it showed, No removes any trust. */
export function rememberAnswer(items: AskItem[], answer: RepoAnswer): void {
  const repos = { ...state.prefs().repos };
  const trusted = { ...state.prefs().trusted };
  for (const it of items) {
    repos[it.repoId] = answer;
    if (answer === "yes") trusted[it.repoId] = it.fingerprint;
    else delete trusted[it.repoId];
  }
  state.setPrefs((p) => ({ ...p, repos, trusted }));
  save({ repos, trusted });
}

/** Forgets every answer and every trust: the next run asks again. */
export function forgetAnswers(): void {
  state.setPrefs((p) => ({ ...p, repos: {}, trusted: {} }));
  save({ repos: null, trusted: null });
}

/** Tests only. */
export function resetAutotestStore(p: Partial<AutotestPrefs> = DEFAULT_PREFS): void {
  state.setResults({});
  state.setAsks({});
  state.setPrefs({ ...DEFAULT_PREFS, ...p });
}
