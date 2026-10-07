import { batch, createSignal } from "solid-js";
import { ipc } from "../../ipc";
import type { GraphRow, LogFilters } from "../../ipc/graph";
import { errorText } from "../../store/snapshots";
import { repos } from "../../store/workspace";

export interface LogSelection {
  repoId: string;
  oid: string;
}

export type Period = "any" | "day" | "week" | "month";
const PERIOD_MS: Record<Exclude<Period, "any">, number> = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 };

const [rows, setRows] = createSignal<GraphRow[]>([]);
const [cursor, setCursor] = createSignal<string | undefined>();
const [loading, setLoading] = createSignal(false);
const [error, setError] = createSignal<string | null>(null);
const [selection, setSelection] = createSignal<LogSelection | null>(null);
/** Repos shown; empty means all of them. */
const [repoFilter, setRepoFilter] = createSignal<readonly string[]>([]);
const [branch, setBranch] = createSignal("");
const [author, setAuthor] = createSignal("");
const [text, setText] = createSignal("");
const [period, setPeriod] = createSignal<Period>("any");
/** Set by the palette command: the detail pane then asks before cherry-picking the selected commit. */
const [cherryConfirm, setCherryConfirm] = createSignal(false);
let generation = 0;

export { author, branch, cherryConfirm, cursor, error, loading, period, repoFilter, rows, selection, setAuthor, setBranch, setCherryConfirm, setPeriod, setSelection, setText, text };

/** Repos the log covers right now. */
export const shownRepoIds = (): string[] => {
  const all = repos().map((r) => r.id);
  const chosen = repoFilter().filter((id) => all.includes(id));
  return chosen.length ? chosen : all;
};

export function toggleRepoFilter(repoId: string): void {
  const current = repoFilter();
  setRepoFilter(current.includes(repoId) ? current.filter((id) => id !== repoId) : [...current, repoId]);
}

export const clearRepoFilter = () => setRepoFilter([]);

export function currentFilters(now = Date.now()): LogFilters {
  const filters: LogFilters = {};
  if (branch().trim()) filters.branch = branch().trim();
  if (author().trim()) filters.author = author().trim();
  if (text().trim()) filters.text = text().trim();
  if (period() !== "any") filters.sinceMs = now - PERIOD_MS[period() as Exclude<Period, "any">];
  return filters;
}

async function fetchPage(from: string | undefined, token: number): Promise<void> {
  setLoading(true);
  try {
    const page = await ipc.graph.logPage(shownRepoIds(), from, currentFilters());
    if (token !== generation) return;
    batch(() => {
      setRows((prev) => (from ? [...prev, ...page.rows] : page.rows));
      setCursor(page.nextCursor ?? undefined);
      setError(null);
    });
  } catch (err) {
    if (token === generation) setError(errorText(err));
  } finally {
    if (token === generation) setLoading(false);
  }
}

/** Starts again from the newest commit with the current repo set and filters. */
export function reloadLog(): Promise<void> {
  const token = ++generation;
  if (!shownRepoIds().length) {
    batch(() => {
      setRows([]);
      setCursor(undefined);
      setLoading(false);
    });
    return Promise.resolve();
  }
  return fetchPage(undefined, token);
}

export function loadMore(): Promise<void> {
  const next = cursor();
  if (!next || loading()) return Promise.resolve();
  return fetchPage(next, generation);
}

export function resetLogState(): void {
  generation++;
  batch(() => {
    setRows([]);
    setCursor(undefined);
    setLoading(false);
    setError(null);
    setSelection(null);
    setCherryConfirm(false);
    setRepoFilter([]);
    setBranch("");
    setAuthor("");
    setText("");
    setPeriod("any");
  });
}
