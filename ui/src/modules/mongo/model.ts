import { batch, createMemo, createSignal, onCleanup } from "solid-js";
import { ipc } from "../../ipc";
import type { PlanView, ProfileView } from "../../ipc/mongo";
import type { AiAsk, AiPayload, AiResult } from "../../ipc/mongoAi";
import { t, type MessageKey } from "../../i18n";
import { announce, readStored, writeStored } from "../../ui-kit";
import { countOf, explainFind, loadDigest as fetchDigest, newTabKey } from "./api";
import type { SchemaDigest } from "./digest";
import { parseDoc, type Doc } from "./ejson";
import { callerZone, effectiveTotal, parseIntField } from "./logic";
import { presetOf } from "./presets";
import { lint, type LintResult } from "./shellLiteral";
import { codeOf, messageOf } from "./store";

export type ViewMode = "table" | "tree" | "json";
export type RunStatus = "idle" | "loading" | "ready" | "error";
export type AiStatus = "idle" | "asking" | "review" | "clarify" | "error";

export interface CollectionRef {
  connectionId: string;
  db: string;
  collection: string;
}

export interface QueryFields {
  filter: string;
  projection: string;
  sort: string;
  limit: string;
  skip: string;
}

export const EMPTY_QUERY: QueryFields = { filter: "", projection: "", sort: "", limit: "", skip: "" };
export const PAGE_SIZES = [25, 50, 100, 200] as const;

const storedPageSize = (): number => {
  const n = Number(readStored("intely.mongo.pageSize"));
  return (PAGE_SIZES as readonly number[]).includes(n) ? n : 50;
};
const viewKey = (r: CollectionRef) => `intely.mongo.view.${r.connectionId}.${r.db}.${r.collection}`;

export interface ErrorView {
  title: string;
  detail: string;
  code: string;
}

const TITLES = {
  mongoParse: "mongo.title.parse",
  mongoRejected: "mongo.title.rejected",
  mongoCancelled: "mongo.title.cancelled",
  mongoNotConnected: "mongo.title.notConnected",
  mongoDisabled: "mongo.title.disabled",
  mongoNoUri: "mongo.title.noUri",
  mongoConnect: "mongo.title.connect",
  mongoServer: "mongo.title.server",
  mongoAiOff: "mongo.title.aiOff",
  mongoNoProvider: "mongo.title.noProvider",
  mongoModelBusy: "mongo.title.modelBusy",
  mongoNoConsent: "mongo.title.noConsent",
  readOnly: "mongo.title.readOnly",
  testJail: "mongo.title.testJail",
  mongoNeedSecret: "mongo.title.needSecret",
  mongoNeedsReview: "mongo.title.needsReview",
  mongoTunnel: "mongo.title.tunnel",
  mongoHostKey: "mongo.title.hostKey",
  mongoImport: "mongo.title.import",
  mongoBusy: "mongo.title.busy",
  mongoHandle: "mongo.title.handle",
  mongoInvalid: "mongo.title.invalid",
} as const satisfies Record<string, MessageKey>;

export function describeError(e: unknown): ErrorView {
  const code = codeOf(e);
  const detail = messageOf(e);
  const slow = /MaxTimeMSExpired|exceeded time limit|maxTimeMS/i.test(detail);
  // Rust refusals that carry a `config.*` slug: the words are the catalog's, not the English sentence of the engine
  const localDetail = detail.startsWith("config.happyPresetOff") ? t("mongo.detail.happyPresetOff") : undefined;
  const key = (TITLES as Record<string, MessageKey>)[code];
  return { title: slow ? t("mongo.title.tooLong") : key ? t(key) : t("mongo.title.generic"), detail: slow ? t("mongo.detail.tooLong") : localDetail ?? detail, code };
}

/** Connections whose payload the user has seen in this session: the first AI call per connection shows it first. */
const seenPayload = new Set<string>();
export const payloadSeen = (id: string) => seenPayload.has(id);
export const markPayloadSeen = (id: string) => void seenPayload.add(id);

/** Everything a collection tab does, apart from drawing: query fields, paged results, schema digest, explain and the AI review flow. */
export function createCollectionModel(ref: CollectionRef, profile: () => ProfileView | undefined) {
  const tab = newTabKey();
  const [q, setQ] = createSignal<QueryFields>({ ...EMPTY_QUERY });
  const [status, setStatus] = createSignal<RunStatus>("idle");
  const [error, setError] = createSignal<ErrorView>();
  const [docs, setDocs] = createSignal<readonly Doc[]>([]);
  const [rawDocs, setRawDocs] = createSignal<readonly string[]>([]);
  const [total, setTotal] = createSignal<{ value: number; exact: boolean }>();
  const [page, setPage] = createSignal(0);
  const [pageSize, setPageSizeSig] = createSignal(storedPageSize());
  const [tookMs, setTookMs] = createSignal(0);
  const [servedBy, setServedBy] = createSignal<"primary" | "secondary">("primary");
  const [truncated, setTruncated] = createSignal(false);
  const [hasMore, setHasMore] = createSignal(false);
  const [view, setViewSig] = createSignal<ViewMode>(((v) => (v === "tree" || v === "json" ? v : "table"))(readStored(viewKey(ref))));
  const [ran, setRan] = createSignal(false);
  /** Skip, limit and page size of the result that is on screen: the footer must not follow the draft the user is still typing. */
  const [applied, setApplied] = createSignal({ skip: 0, limit: 0, pageSize: pageSize() });
  let seq = 0;
  let alive = true;
  onCleanup(() => {
    alive = false;
    if (status() === "loading") void ipc.mongo.cancel(tab).catch(() => undefined);
    void ipc.mongo.cursorClose(tab).catch(() => undefined);
  });

  // --- query fields and their lint ---
  const lints = createMemo<{ filter: LintResult; projection: LintResult; sort: LintResult }>(() => ({ filter: lint(q().filter), projection: lint(q().projection), sort: lint(q().sort) }));
  const firstProblem = createMemo(() => {
    const l = lints();
    for (const [name, r] of [[t("mongo.query.filter"), l.filter], [t("mongo.query.project"), l.projection], [t("mongo.query.sort"), l.sort]] as const) if (!r.ok) return t("mongo.query.problem", { name, message: r.message, line: r.line, column: r.column });
    return undefined;
  });
  let applying = false;
  const setField = (k: keyof QueryFields, v: string) => {
    setQ((cur) => ({ ...cur, [k]: v }));
    if (draft() && !applying) setEdited(true);
  };

  const command = () => {
    const f = q();
    const limit = parseIntField(f.limit);
    const skip = parseIntField(f.skip);
    return {
      cmd: "find" as const,
      db: ref.db,
      collection: ref.collection,
      filter: f.filter,
      projection: f.projection.trim() || undefined,
      sort: f.sort.trim() || undefined,
      skip: skip || undefined,
      limit: limit || undefined,
    };
  };

  // --- running ---
  const applyWindow = (w: Awaited<ReturnType<typeof ipc.mongo.window>>, toPage: number) => {
    const parsed = w.docs.map(parseDoc);
    batch(() => {
      setDocs(parsed);
      setRawDocs(w.docs);
      setPage(toPage);
      setTookMs(w.elapsedMs);
      setServedBy(w.secondaryOk ? "secondary" : "primary");
      setTruncated(w.truncated);
      setHasMore(w.hasMore);
      setStatus("ready");
      setRan(true);
    });
    announce(`Loaded ${parsed.length} documents`);
  };

  /** A new find: the first window comes with the run, the count in parallel. Later pages are windows of the same cursor. */
  async function run(): Promise<boolean> {
    const problem = firstProblem();
    if (problem) {
      batch(() => (setError({ title: t("mongo.query.fixFirst"), detail: problem, code: "mongoParse" }), setStatus("error")));
      return false;
    }
    const mine = ++seq;
    setStatus("loading");
    setError(undefined);
    const cmd = command();
    const size = pageSize();
    try {
      const counted = countOf(ref.connectionId, tab, ref.db, ref.collection, q().filter).then((c) => ({ value: c.value, exact: !!q().filter.trim() && !c.capped })).catch(() => undefined);
      const w = await ipc.mongo.run({ tab, connection: ref.connectionId, command: cmd, pageSize: size });
      if (!alive || mine !== seq) return false;
      batch(() => (setTotal(undefined), setExplainResult(undefined), setApplied({ skip: cmd.skip ?? 0, limit: cmd.limit ?? 0, pageSize: size })));
      applyWindow(w, 0);
      void counted.then((t) => alive && mine === seq && setTotal(t));
      return true;
    } catch (e) {
      if (!alive || mine !== seq) return false;
      const v = describeError(e);
      if (v.code === "mongoCancelled") return (setStatus(ran() ? "ready" : "idle"), announce("Query cancelled"), false);
      batch(() => (setError(v), setStatus("error")));
      return false;
    }
  }

  async function goto(p: number): Promise<boolean> {
    const target = Math.min(Math.max(p, 0), lastPage());
    if (!ran()) return run();
    const mine = ++seq;
    setStatus("loading");
    try {
      const w = await ipc.mongo.window(tab, target * pageSize(), pageSize());
      if (!alive || mine !== seq) return false;
      applyWindow(w, target);
      return true;
    } catch (e) {
      if (!alive || mine !== seq) return false;
      const v = describeError(e);
      if (v.code === "mongoCancelled") return (setStatus("ready"), false);
      batch(() => (setError(v), setStatus("error")));
      return false;
    }
  }

  const cancel = () => {
    if (status() === "loading") void ipc.mongo.cancel(tab).catch(() => undefined);
  };
  function reset() {
    batch(() => {
      setQ({ ...EMPTY_QUERY });
      discardDraft(false);
    });
    return run();
  }
  const shownTotal = () => {
    const t = total();
    return t ? { value: effectiveTotal(t.value, applied().skip, applied().limit), exact: t.exact } : undefined;
  };
  const lastPage = () => {
    const t = shownTotal();
    if (!t) return hasMore() ? page() + 1 : page();
    return Math.max(0, Math.ceil(t.value / applied().pageSize) - 1);
  };
  const setPageSize = (n: number) => {
    setPageSizeSig(n);
    writeStored("intely.mongo.pageSize", String(n));
    if (ran()) void run();
  };
  const setView = (v: ViewMode) => (setViewSig(v), writeStored(viewKey(ref), v));

  /** Sort headers write the Sort editor and run again. */
  function sortBy(column: string, dir: 1 | -1 | null) {
    setField("sort", dir === null ? "" : `{ ${/^[A-Za-z_$][\w$]*$/.test(column) ? column : JSON.stringify(column)}: ${dir} }`);
    void run();
  }

  // --- schema digest ---
  const [digest, setDigest] = createSignal<SchemaDigest>();
  const [digestError, setDigestError] = createSignal<string>();
  const [digestBusy, setDigestBusy] = createSignal(false);
  async function loadDigest() {
    setDigestBusy(true);
    try {
      const d = await fetchDigest(ref.connectionId, tab, ref.db, ref.collection, 200, presetOf(profile()?.domain).tenantCandidates);
      if (alive) (setDigest(d), setDigestError(undefined));
    } catch (e) {
      if (alive) setDigestError(messageOf(e));
    } finally {
      if (alive) setDigestBusy(false);
    }
  }

  // --- explain ---
  const [explainResult, setExplainResult] = createSignal<{ plan: PlanView; raw: string; elapsedMs: number; stats: boolean }>();
  const [explainStatus, setExplainStatus] = createSignal<RunStatus>("idle");
  const [explainError, setExplainError] = createSignal<ErrorView>();
  const [explainText, setExplainText] = createSignal<string>();
  async function explain(executionStats = false) {
    const problem = firstProblem();
    if (problem) return (setExplainError({ title: t("mongo.query.fixFirst"), detail: problem, code: "mongoParse" }), setExplainStatus("error"));
    setExplainStatus("loading");
    setExplainError(undefined);
    setExplainText(undefined);
    try {
      const r = await explainFind(ref.connectionId, tab, command(), executionStats);
      if (alive) (setExplainResult({ ...r, stats: executionStats }), setExplainStatus("ready"));
    } catch (e) {
      if (alive) (setExplainError(describeError(e)), setExplainStatus("error"));
    }
  }

  // --- AI ---
  const [question, setQuestion] = createSignal("");
  const [aiStatus, setAiStatus] = createSignal<AiStatus>("idle");
  const [aiError, setAiError] = createSignal<ErrorView>();
  const [aiResult, setAiResult] = createSignal<AiResult>();
  const [clarify, setClarify] = createSignal<string>();
  const [edited, setEdited] = createSignal(false);
  const [changed, setChanged] = createSignal<ReadonlySet<string>>(new Set<string>());
  const [accepted, setAccepted] = createSignal<AiResult>();
  const [elapsed, setElapsed] = createSignal(0);
  let before: QueryFields | undefined;
  let askTimer: ReturnType<typeof setInterval> | undefined;
  const stopTimer = () => (askTimer && clearInterval(askTimer), (askTimer = undefined), setElapsed(0));
  onCleanup(() => {
    stopTimer();
    if (aiStatus() === "asking") void ipc.mongoAi.cancel(tab).catch(() => undefined);
  });
  const draft = () => aiResult()?.draft;

  const aiAllowed = () => profile()?.aiMode === "schemaOnly" || profile()?.aiMode === "schemaEnums";
  const askReq = (fix = false): AiAsk => {
    const f = q();
    const hasEditor = !!(f.filter.trim() || f.projection.trim() || f.sort.trim() || draft() || fix);
    return {
      tab,
      connection: ref.connectionId,
      db: ref.db,
      collection: ref.collection,
      question: question().trim(),
      ...callerZone(),
      ...(hasEditor ? { editor: { filter: f.filter, projection: f.projection, sort: f.sort, limit: parseIntField(f.limit) || undefined, returned: fix ? total()?.value : undefined } } : {}),
    };
  };

  const loadPayload = (): Promise<AiPayload> => ipc.mongoAi.payload(askReq());

  async function ask(fix = false): Promise<boolean> {
    if (!question().trim() && !fix) return false;
    setAiStatus("asking");
    setAiError(undefined);
    setClarify(undefined);
    setAccepted(undefined);
    const t0 = Date.now();
    stopTimer();
    askTimer = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    try {
      const r = await ipc.mongoAi.generate(askReq(fix));
      stopTimer();
      if (!alive) return false;
      if (r.status === "needsClarification") return (batch(() => (setClarify(r.clarification ?? ""), setAiStatus("clarify"))), false);
      if (r.status === "failed" || !r.draft) return (batch(() => (setAiError({ title: t("mongo.ai.invalid"), detail: r.message || r.problems.join(" "), code: "failed" }), setAiStatus("error"))), false);
      const d = r.draft;
      applying = true;
      if (!aiResult()) before = { ...q() };
      batch(() => {
        setQ((cur) => ({ ...cur, filter: d.filter, projection: d.projection, sort: d.sort, limit: d.limit ? String(d.limit) : "" }));
        setChanged(new Set<string>(d.changedFields));
        setAiResult(r);
        setEdited(false);
        setAiStatus("review");
      });
      applying = false;
      announce("Query generated, review it before running");
      return true;
    } catch (e) {
      applying = false;
      stopTimer();
      if (!alive) return false;
      const v = describeError(e);
      // a Cancel is not an error: back to where the user was
      if (v.code === "mongoCancelled") return (batch(() => (setAiStatus(aiResult() ? "review" : "idle"), announce("Cancelled"))), false);
      batch(() => (setAiError(v), setAiStatus("error")));
      return false;
    }
  }
  /** Stops the model call in flight (Cancel button and Esc while the AI bar is working). */
  const cancelAsk = () => {
    if (aiStatus() === "asking") void ipc.mongoAi.cancel(tab).catch(() => undefined);
  };
  function discardDraft(restore = true) {
    batch(() => {
      if (restore && before) setQ(before);
      before = undefined;
      setAiResult(undefined);
      setChanged(new Set<string>());
      setEdited(false);
      setClarify(undefined);
      setAiStatus("idle");
      setAiError(undefined);
    });
  }
  async function runDraft() {
    const r = aiResult();
    const ok = await run();
    if (ok) batch(() => (setChanged(new Set<string>()), setAiStatus("idle"), setAccepted(r), setAiResult(undefined)));
    return ok;
  }
  /** After a run: Fix asks the model again, with the counts only. */
  const fix = () => ask(true);
  async function explainInWords() {
    try {
      const r = await ipc.mongoAi.explain({ ...askReq(), plan: explainResult()?.plan.stages });
      if (alive) setExplainText(r.text);
    } catch (e) {
      if (alive) setExplainText(messageOf(e));
    }
  }

  const ai = { elapsed, cancelAsk, question, setQuestion, status: aiStatus, error: aiError, result: aiResult, draft, clarification: clarify, edited, changed, accepted, allowed: aiAllowed, loadPayload, ask, discardDraft, runDraft, fix, explainInWords };

  return {
    tab, ref, q, setField, setQuery: setQ, lints, firstProblem,
    status, error, docs, rawDocs, total: shownTotal, applied, page, pageSize, setPageSize, tookMs, servedBy, truncated, hasMore, ran, lastPage,
    run, cancel, reset, goto, sortBy, view, setView,
    digest, digestError, digestBusy, loadDigest,
    explain, explainResult, explainStatus, explainError, explainText,
    ai,
  };
}

export type CollectionModel = ReturnType<typeof createCollectionModel>;
