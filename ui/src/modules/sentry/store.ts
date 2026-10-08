// State of the Sentry tab, kept at module level because the centre area remounts a tab whenever it is activated.
import { batch, createSignal } from "solid-js";
import { readStored, writeStored } from "../../ui-kit";
import { sentryApi, problemOf } from "./api";
import { DEFAULT_QUERY, PERIODS, SORTS, STATUSES, sameList } from "./logic";
import type { SentryDetail, SentryIssue, SentryProblem, SentryProject, SentryQuery, SentryStatus } from "./types";

const FILTERS_KEY = "intely.sentry.filters";

/** The filters that are worth keeping between launches: the words of a search are not. */
function readFilters(): SentryQuery {
  try {
    const raw = JSON.parse(readStored(FILTERS_KEY) ?? "null") as Partial<SentryQuery> | null;
    return {
      ...DEFAULT_QUERY,
      ...(raw && STATUSES.includes(raw.status as never) ? { status: raw.status! } : {}),
      ...(raw && PERIODS.includes(raw.period as never) ? { period: raw.period! } : {}),
      ...(raw && SORTS.includes(raw.sort as never) ? { sort: raw.sort! } : {}),
      ...(raw && typeof raw.project === "string" && /^\d+$/.test(raw.project) ? { project: raw.project } : {}),
    };
  } catch {
    return { ...DEFAULT_QUERY };
  }
}

const [status, setStatus] = createSignal<SentryStatus | undefined>(undefined);
const [filters, setFiltersSignal] = createSignal<SentryQuery>(readFilters());
const [issues, setIssues] = createSignal<SentryIssue[]>([]);
const [nextCursor, setNextCursor] = createSignal<string | null>(null);
const [loading, setLoading] = createSignal(false);
const [loadingMore, setLoadingMore] = createSignal(false);
const [problem, setProblem] = createSignal<SentryProblem | undefined>(undefined);
const [loaded, setLoaded] = createSignal(false);
const [projects, setProjects] = createSignal<SentryProject[]>([]);
const [selectedId, setSelectedId] = createSignal<string | undefined>(undefined);
const [detail, setDetail] = createSignal<SentryDetail | undefined>(undefined);
const [detailLoading, setDetailLoading] = createSignal(false);
const [detailProblem, setDetailProblem] = createSignal<SentryProblem | undefined>(undefined);

export { detail, detailLoading, detailProblem, filters, issues, loaded, loading, loadingMore, nextCursor, problem, projects, selectedId, status };

// Answers that arrive after a newer ask are dropped.
let listTicket = 0;
let detailTicket = 0;

export async function loadStatus(): Promise<SentryStatus | undefined> {
  try {
    const s = await sentryApi().status();
    setStatus(s);
    return s;
  } catch (e) {
    setProblem(problemOf(e));
    return undefined;
  }
}

export function setConfigStatus(next: SentryStatus): void {
  setStatus(next);
}

/** Changes filters; a change of what is asked reloads the list (the caller decides when: typing waits, a menu does not). */
export function setFilters(patch: Partial<SentryQuery>): void {
  setFiltersSignal((f) => ({ ...f, ...patch, cursor: null }));
  const { query: _words, ...keep } = filters();
  writeStored(FILTERS_KEY, JSON.stringify(keep));
}

/** Reads the first page of the list for the current filters. */
export async function reload(): Promise<void> {
  const ticket = ++listTicket;
  const asked = filters();
  setLoading(true);
  try {
    const page = await sentryApi().issues({ ...asked, cursor: null });
    if (ticket !== listTicket) return;
    batch(() => {
      setIssues(page.issues);
      setNextCursor(page.nextCursor);
      setProblem(undefined);
      setLoaded(true);
      // the open issue stays open only while it is still in the list
      if (selectedId() && !page.issues.some((i) => i.id === selectedId())) void select(undefined);
    });
  } catch (e) {
    if (ticket !== listTicket) return;
    batch(() => {
      setProblem(problemOf(e));
      setLoaded(true);
    });
  } finally {
    if (ticket === listTicket) setLoading(false);
  }
}

/** The next page, appended; it belongs to the filters it was asked with and is dropped when they changed meanwhile. */
export async function loadMore(): Promise<void> {
  const cursor = nextCursor();
  if (!cursor || loadingMore() || loading()) return;
  const ticket = listTicket;
  const asked = filters();
  setLoadingMore(true);
  try {
    const page = await sentryApi().issues({ ...asked, cursor });
    if (ticket !== listTicket || !sameList(asked, filters())) return;
    batch(() => {
      const seen = new Set(issues().map((i) => i.id));
      setIssues([...issues(), ...page.issues.filter((i) => !seen.has(i.id))]);
      setNextCursor(page.nextCursor);
    });
  } catch (e) {
    if (ticket === listTicket) setProblem(problemOf(e));
  } finally {
    setLoadingMore(false);
  }
}

export async function loadProjects(): Promise<void> {
  try {
    setProjects(await sentryApi().projects());
  } catch {
    setProjects([]);
  }
}

/** Opens an issue (reads it with its newest event) or closes the detail with `undefined`. */
export async function select(id: string | undefined): Promise<void> {
  const ticket = ++detailTicket;
  setSelectedId(id);
  if (!id) {
    batch(() => {
      setDetail(undefined);
      setDetailProblem(undefined);
      setDetailLoading(false);
    });
    return;
  }
  batch(() => {
    setDetailLoading(true);
    setDetailProblem(undefined);
    if (detail()?.issue.id !== id) setDetail(undefined);
  });
  try {
    const d = await sentryApi().issue(id);
    if (ticket !== detailTicket) return;
    setDetail(d);
  } catch (e) {
    if (ticket === detailTicket) setDetailProblem(problemOf(e));
  } finally {
    if (ticket === detailTicket) setDetailLoading(false);
  }
}

/** An issue changed at Sentry (assigned, resolved): the list row and the open detail follow. */
export function applyIssue(updated: SentryIssue): void {
  batch(() => {
    setIssues((list) => list.map((i) => (i.id === updated.id ? { ...i, ...updated, count: updated.count || i.count } : i)));
    const d = detail();
    if (d && d.issue.id === updated.id) setDetail({ ...d, issue: { ...d.issue, ...updated, count: updated.count || d.issue.count } });
  });
}

export async function assignMe(id: string): Promise<SentryIssue> {
  const updated = await sentryApi().assignMe(id).catch((e) => Promise.reject(problemOf(e)));
  applyIssue(updated);
  return updated;
}

export async function setIssueStatus(id: string, next: "resolved" | "unresolved" | "ignored"): Promise<SentryIssue> {
  const updated = await sentryApi().setStatus(id, next).catch((e) => Promise.reject(problemOf(e)));
  applyIssue(updated);
  return updated;
}

export function resetSentry(): void {
  listTicket++;
  detailTicket++;
  batch(() => {
    setStatus(undefined);
    setFiltersSignal({ ...DEFAULT_QUERY });
    setIssues([]);
    setNextCursor(null);
    setLoading(false);
    setLoadingMore(false);
    setProblem(undefined);
    setLoaded(false);
    setProjects([]);
    setSelectedId(undefined);
    setDetail(undefined);
    setDetailLoading(false);
    setDetailProblem(undefined);
  });
}
