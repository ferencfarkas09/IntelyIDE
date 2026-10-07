// State of the Session search tab, kept at module level because the centre area remounts a tab whenever it is activated.
import { batch, createSignal } from "solid-js";
import { historyApi } from "./api";
import type { Facets, SearchHit, SearchQuery } from "./types";

export type When = "any" | "day" | "week" | "month";
const SPAN: Record<Exclude<When, "any">, number> = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 };

export interface Filters {
  repo: string;
  role: string;
  model: string;
  status: string;
  when: When;
}

export const NO_FILTERS: Filters = { repo: "", role: "", model: "", status: "", when: "any" };

const [text, setText] = createSignal("");
const [filters, setFilters] = createSignal<Filters>(NO_FILTERS);
const [hits, setHits] = createSignal<SearchHit[]>([]);
const [total, setTotal] = createSignal(0);
const [facets, setFacets] = createSignal<Facets>({ repos: [], roles: [], models: [], statuses: [] });
const [indexed, setIndexed] = createSignal(0);
const [tookMs, setTookMs] = createSignal(0);
const [busy, setBusy] = createSignal(false);
const [error, setError] = createSignal<string | undefined>(undefined);
const [searched, setSearched] = createSignal(false);

export { busy, error, facets, filters, hits, indexed, searched, setFilters, setText, text, tookMs, total };

/** The query the backend gets: empty filters are left out; "when" becomes a start time. */
export function toQuery(t: string, f: Filters, now: number = Date.now()): SearchQuery {
  return {
    text: t,
    ...(f.repo ? { repo: f.repo } : {}),
    ...(f.role ? { role: f.role } : {}),
    ...(f.model ? { model: f.model } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.when !== "any" ? { fromMs: now - SPAN[f.when] } : {}),
    limit: 50,
  };
}

let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Runs the search now; a newer call makes an older answer irrelevant. */
export async function runSearch(reindex = false): Promise<void> {
  const mine = ++seq;
  setBusy(true);
  try {
    const out = await historyApi().search(toQuery(text(), filters()), reindex);
    if (mine !== seq) return;
    batch(() => {
      setHits(out.hits);
      setTotal(out.total);
      setFacets(out.facets);
      setIndexed(out.indexed);
      setTookMs(out.tookMs);
      setError(undefined);
      setSearched(true);
    });
  } catch (e) {
    if (mine !== seq) return;
    setError(e instanceof Error ? e.message : String((e as { message?: string }).message ?? e));
    setSearched(true);
  } finally {
    if (mine === seq) setBusy(false);
  }
}

/** Typing: the search follows after a short pause. */
export function searchSoon(delay = 220): void {
  clearTimeout(timer);
  timer = setTimeout(() => void runSearch(), delay);
}

export function resetSearch(): void {
  clearTimeout(timer);
  seq += 1;
  batch(() => {
    setText("");
    setFilters(NO_FILTERS);
    setHits([]);
    setTotal(0);
    setFacets({ repos: [], roles: [], models: [], statuses: [] });
    setIndexed(0);
    setBusy(false);
    setError(undefined);
    setSearched(false);
  });
}
