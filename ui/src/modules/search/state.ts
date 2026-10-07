import { batch, createSignal } from "solid-js";
import { ipc } from "../../ipc";
import type { SearchBatch, SearchHit } from "../../ipc/search";
import { errorText } from "../../store/snapshots";
import { repos } from "../../store/workspace";
import { regexError } from "./logic";

export const MAX_HITS = 2000;
/** Typing searches on its own from this length on; Enter searches any non-empty query. */
export const AUTO_MIN_LENGTH = 2;
const DEBOUNCE_MS = 250;

export type SearchStatus = "idle" | "running" | "done" | "error";

const [query, setQueryRaw] = createSignal("");
const [regex, setRegexRaw] = createSignal(false);
const [caseSensitive, setCaseRaw] = createSignal(false);
const [glob, setGlobRaw] = createSignal("");
const [excluded, setExcluded] = createSignal<ReadonlySet<string>>(new Set<string>());
const [hits, setHits] = createSignal<readonly SearchHit[]>([]);
const [status, setStatus] = createSignal<SearchStatus>("idle");
const [error, setError] = createSignal<string | undefined>(undefined);
const [truncated, setTruncated] = createSignal(false);
const [notice, setNotice] = createSignal<string | undefined>(undefined);
const [focusTick, setFocusTick] = createSignal(0);

export { caseSensitive, error, excluded, focusTick, glob, hits, notice, query, regex, status, truncated };

let generation = 0;
let current: string | null = null;
let starting = false;
let buffer: SearchBatch[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let unsubscribe: (() => void) | undefined;

const cancelCurrent = () => {
  if (current) void ipc.search.cancel(current).catch(() => {});
  current = null;
  starting = false;
  buffer = [];
};

function apply(b: SearchBatch): void {
  batch(() => {
    // Sticky across searches: whether ripgrep exists does not change between two queries.
    if (b.done) setNotice(b.notice);
    const room = MAX_HITS - hits().length;
    if (b.hits.length) setHits((all) => [...all, ...b.hits.slice(0, Math.max(0, room))]);
    if (b.hits.length > room) {
      // The list is full: stop the engine instead of letting it stream thousands more.
      setTruncated(true);
      setStatus("done");
      cancelCurrent();
    } else if (b.done) setStatus("done");
  });
}

function onBatch(b: SearchBatch): void {
  if (b.searchId === current) apply(b);
  else if (starting) buffer.push(b);
}

function reset(next: SearchStatus, message?: string): void {
  batch(() => {
    setHits([]);
    setTruncated(false);
    setStatus(next);
    setError(message);
  });
}

/** Starts a search for the current query and options; whatever ran before is cancelled. */
export async function runSearch(): Promise<void> {
  clearTimeout(timer);
  const id = ++generation;
  cancelCurrent();
  const q = query();
  const repoIds = repos().map((r) => r.id).filter((r) => !excluded().has(r));
  if (!q) return reset("idle");
  const bad = regexError({ query: q, regex: regex(), caseSensitive: caseSensitive() });
  if (bad) return reset("error", bad);
  if (repoIds.length === 0) return reset("idle");
  reset("running");
  unsubscribe ??= ipc.search.onResults(onBatch);
  starting = true;
  buffer = [];
  try {
    const { searchId } = await ipc.search.start(q, { repoIds, regex: regex(), caseSensitive: caseSensitive(), glob: glob().trim() || undefined });
    if (id !== generation) return void ipc.search.cancel(searchId).catch(() => {});
    current = searchId;
    starting = false;
    const early = buffer.filter((b) => b.searchId === searchId);
    buffer = [];
    early.forEach(apply);
  } catch (e) {
    if (id !== generation) return;
    starting = false;
    reset("error", errorText(e));
  }
}

/** Debounced search for typing. */
export function scheduleSearch(): void {
  clearTimeout(timer);
  if (query().length < AUTO_MIN_LENGTH) {
    generation++;
    cancelCurrent();
    return reset("idle");
  }
  timer = setTimeout(() => void runSearch(), DEBOUNCE_MS);
}

export function setQuery(value: string): void {
  setQueryRaw(value);
  scheduleSearch();
}
const rerun = () => void (query() && runSearch());
export const toggleRegex = () => (setRegexRaw(!regex()), rerun());
export const toggleCase = () => (setCaseRaw(!caseSensitive()), rerun());
export function setGlob(value: string): void {
  setGlobRaw(value);
  if (query()) scheduleSearch();
}
export function toggleRepo(repoId: string): void {
  setExcluded((all) => {
    const next = new Set(all);
    if (!next.delete(repoId)) next.add(repoId);
    return next;
  });
  rerun();
}

export function cancelSearch(): void {
  clearTimeout(timer);
  generation++;
  cancelCurrent();
  if (status() === "running") setStatus("done");
}

export const requestFocus = () => setFocusTick((n) => n + 1);

export function resetSearch(): void {
  clearTimeout(timer);
  generation++;
  cancelCurrent();
  unsubscribe?.();
  unsubscribe = undefined;
  starting = false;
  buffer = [];
  batch(() => {
    setQueryRaw("");
    setRegexRaw(false);
    setCaseRaw(false);
    setGlobRaw("");
    setExcluded(new Set<string>());
  });
  reset("idle");
  setNotice(undefined);
}
