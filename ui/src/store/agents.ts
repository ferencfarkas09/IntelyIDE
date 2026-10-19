import { batch, createSignal } from "solid-js";
import { ipc as defaultIpc, type Ipc } from "../ipc";
import { announcement } from "../components/chat/format";
import { emptyView, markPermissionAnswered, markPermissionRefused, markQuestionAnswered, pendingPermissions, pendingQuestions, reduceEvents, runStatus, type AgentView } from "./agent-reducer";
import type { FileSelection } from "../modules/attachments/types";
import type { AgentAttachment, AgentEvent, AgentStartRequest, AgentSummary, McpServerInfo, PermissionDecision, PermissionMode, QuestionAnswer, RoleInfo, RunStatus } from "./agent-types";
import { endStarting, resetStarting, setStartingFront, startingInFront, startingRun } from "./starting";

export type { AgentView } from "./agent-reducer";

const [summaries, setSummaries] = createSignal<AgentSummary[]>([]);
const [views, setViews] = createSignal<Record<string, AgentView>>({});
const [roleList, setRoleList] = createSignal<RoleInfo[]>([]);
const [selected, setSelected] = createSignal<string | null>(null);
const [interrupting, setInterrupting] = createSignal<Record<string, true>>({});
const [drafts, setDrafts] = createSignal<Record<string, string>>({});
const [loadError, setLoadError] = createSignal<string | undefined>(undefined);
const [loaded, setLoaded] = createSignal(false);
const [spoken, setSpoken] = createSignal("");

/** Live events of runs whose history has not been loaded yet; replayed after it (seq-filtered by the reducer). */
let pending = new Map<string, AgentEvent[]>();
let client: Ipc = defaultIpc;

/** A summary with everything the live view knows folded in. */
export interface AgentRow extends AgentSummary {
  status: RunStatus;
  needs: number;
  /** Set while a running turn waits on the provider; the status stays `running`. */
  throttle?: AgentView["throttle"];
  /** From `session.info`: the CLI's slash commands and the MCP servers of the run (state at init). */
  slashCommands?: string[];
  mcpServers?: McpServerInfo[];
}

function merge(summary: AgentSummary, view: AgentView | undefined): AgentRow {
  if (!view) return { ...summary, needs: 0 };
  const needs = pendingPermissions(view).length + pendingQuestions(view).length;
  const effective = view.session ? { permission: view.session.effective.permission as AgentSummary["permission"], effort: view.session.effective.effort as AgentSummary["requested"]["effort"], sandbox: view.session.effective.sandbox } : summary.effective;
  return { ...summary, title: view.title ?? summary.title, model: view.session?.model || summary.model, effective, usage: view.usage ?? summary.usage, caps: view.caps ?? summary.caps, status: view.lastSeq > 0 ? runStatus(view) : summary.status, needs, throttle: view.throttle, ...(view.slashCommands?.length ? { slashCommands: view.slashCommands } : {}), ...(view.mcpServers?.length ? { mcpServers: view.mcpServers } : {}), ...((view.delegates ?? summary.delegates)?.length ? { delegates: view.delegates ?? summary.delegates } : {}) };
}

export const agentRows = (): AgentRow[] => summaries().map((s) => merge(s, views()[s.agentId]));
/** The ids of every run the host knows. */
export const agentIds = (): ReadonlySet<string> => new Set(summaries().map((s) => s.agentId));
/** Which of `ids` are working or waiting for the person now. Looks at those runs only, without merging the live view of every run. */
export function liveAmong(ids: ReadonlySet<string>): string[] {
  if (ids.size === 0) return [];
  const byId = new Map(summaries().map((s) => [s.agentId, s]));
  const all = views();
  const live: string[] = [];
  for (const id of ids) {
    const summary = byId.get(id);
    if (!summary) continue;
    const view = all[id];
    const status = view && view.lastSeq > 0 ? runStatus(view) : summary.status;
    if (status === "running" || status === "needsYou") live.push(id);
  }
  return live;
}
/** The merged row of the last (summary, view) pair seen for each run: an event of another run leaves it the same object, so panes of idle runs do not redraw. */
const rowCache = new Map<string, { summary: AgentSummary; view: AgentView | undefined; row: AgentRow }>();
export function agentRow(id: string | null): AgentRow | undefined {
  if (!id) return undefined;
  const summary = summaries().find((s) => s.agentId === id);
  if (!summary) return void rowCache.delete(id);
  const view = views()[id];
  const hit = rowCache.get(id);
  if (hit && hit.summary === summary && hit.view === view) return hit.row;
  const row = merge(summary, view);
  rowCache.set(id, { summary, view, row });
  return row;
}
export const agentView = (id: string): AgentView | undefined => views()[id];
export const agentRoles = roleList;
export const selectedAgentId = selected;
export const isInterrupting = (id: string): boolean => !!interrupting()[id];
export const agentsLoaded = loaded;
/** The latest line for the screen-reader live region of the chat panel. */
export const agentAnnouncement = spoken;
export const agentsError = loadError;
export const agentDraft = (id: string): string => drafts()[id] ?? "";
export const setAgentDraft = (id: string, text: string): void => void setDrafts((d) => ({ ...d, [id]: text }));
export const needsYouCount = (): number => agentRows().reduce((n, r) => n + (r.status === "needsYou" ? 1 : 0), 0);

function putView(view: AgentView): void {
  setViews((all) => ({ ...all, [view.agentId]: view }));
}

function upsertSummary(summary: AgentSummary): void {
  setSummaries((all) => (all.some((s) => s.agentId === summary.agentId) ? all.map((s) => (s.agentId === summary.agentId ? summary : s)) : [summary, ...all]));
}

function onEvents(events: AgentEvent[]): void {
  const byAgent = new Map<string, AgentEvent[]>();
  for (const ev of events) byAgent.set(ev.agentId, [...(byAgent.get(ev.agentId) ?? []), ev]);
  let unknown = false;
  const say = events.map(announcement).filter((t): t is string => t !== undefined).pop();
  batch(() => {
    if (say) setSpoken(say);
    for (const [id, list] of byAgent) {
      const known = summaries().some((s) => s.agentId === id);
      const view = views()[id];
      if (view) {
        const next = reduceEvents(view, list);
        if (next !== view) putView(next);
        if (list.some((e) => e.kind === "turn.end")) setInterrupting(({ [id]: _drop, ...rest }) => rest);
      } else if (known) {
        pending.set(id, [...(pending.get(id) ?? []), ...list]);
      } else {
        unknown = true;
        putView(reduceEvents(emptyView(id), list));
      }
    }
  });
  if (unknown) void refreshList();
}

async function refreshList(): Promise<void> {
  setSummaries(await client.agentList());
}

async function loadHistory(agentId: string): Promise<void> {
  if (views()[agentId]) return;
  const history = await client.agentHistory(agentId);
  if (views()[agentId]) return;
  const queued = pending.get(agentId) ?? [];
  pending.delete(agentId);
  putView(reduceEvents(emptyView(agentId), [...history, ...queued]));
}

let unsubscribe: (() => void) | undefined;

/**
 * Subscribes first so nothing that happens during the initial loads is lost, then loads the list and roles.
 * Idempotent: the subscription lives for the whole session, so closing and reopening the dock loses no events.
 */
export function startAgentStore(ipc: Ipc = defaultIpc): void {
  if (unsubscribe) return;
  client = ipc;
  unsubscribe = ipc.onAgentEvents(onEvents);
  void (async () => {
    try {
      const [list, roles] = await Promise.all([ipc.agentList(), ipc.agentRoles()]);
      batch(() => {
        setSummaries(list);
        setRoleList(roles);
        setLoaded(true);
      });
      // Live runs load their history now, so requests waiting for the user show up in the badge and the inbox before any run is opened.
      const live = list.filter((s) => s.status === "running" || s.status === "needsYou");
      await Promise.all(live.map((s) => loadHistory(s.agentId)));
      if (live.length && selected() === null) setSelected(live[0].agentId);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String((e as { message?: string }).message ?? e));
      setLoaded(true);
    }
  })();
}

export async function selectAgent(agentId: string | null): Promise<void> {
  batch(() => {
    setStartingFront(null);
    setSelected(agentId);
  });
  if (agentId) await loadHistory(agentId);
}

/** Puts a run that is still starting in front (its card fills the middle); no run is selected meanwhile. */
export function selectStartingRun(key: string): void {
  batch(() => {
    setSelected(null);
    setStartingFront(key);
  });
}

/**
 * Starts a run. `key` names the starting card of this run (New run dialog): the card goes when the host answers, and the new run takes
 * its place in front. A card the person has moved away from does not pull them back; a run started without a shown card is selected, as ever.
 */
export async function startRun(req: AgentStartRequest & { share?: boolean; team?: { index: number; of: number; leadId?: string } }, opts?: { runWithoutSafetyNet?: boolean; confirmBypass?: boolean }, key?: string): Promise<AgentSummary> {
  const summary = await client.agentStart(req, opts);
  batch(() => {
    pending.delete(summary.agentId);
    if (!views()[summary.agentId]) putView(emptyView(summary.agentId));
    upsertSummary(summary);
    const card = startingRun(key ?? null);
    const take = !card?.shown || startingInFront() === card.key;
    if (card) endStarting(card.key);
    if (take) setSelected(summary.agentId);
  });
  return summary;
}

export async function sendMessage(agentId: string, text: string, attachments?: AgentAttachment[], files?: FileSelection): Promise<void> {
  await client.agentSend(agentId, text, attachments?.length ? attachments : undefined, files);
}

/** Adds a note to the running turn: for the subagent of the `Agent` call `parentToolId`, or the lead. The transcript shows it through the `note` events. */
export async function sendNote(agentId: string, text: string, parentToolId?: string): Promise<void> {
  await client.agentNote(agentId, parentToolId, text);
}

export async function interruptRun(agentId: string): Promise<void> {
  setInterrupting((m) => ({ ...m, [agentId]: true }));
  try {
    await client.agentInterrupt(agentId);
  } catch (e) {
    setInterrupting(({ [agentId]: _drop, ...rest }) => rest);
    throw e;
  }
}

/** What an ExitPlanMode answer adds: the mode to continue in (approval) or the user's note (rejection). */
export interface AnswerExtra {
  mode?: PermissionMode;
  feedback?: string;
}

/**
 * The card shows the answer at once. When the host refuses it (`writeLease`, `noSlot`, `optionNotOffered`, `modeChanged`...) the
 * card goes back to pending with the reason (or resolves as withdrawn for `modeChanged`) and the error is rethrown to the caller.
 */
export async function answerPermission(agentId: string, reqId: string, decision: PermissionDecision, extra?: AnswerExtra): Promise<void> {
  const view = views()[agentId];
  if (view) putView(markPermissionAnswered(view, reqId, decision, extra));
  try {
    await client.agentAnswerPermission(agentId, reqId, decision, extra);
  } catch (e) {
    const now = views()[agentId];
    const err = e as { code?: string; message?: string } | null;
    if (now) putView(markPermissionRefused(now, reqId, err?.code ?? "generic", err?.message));
    throw e;
  }
}

/** Live mode switch (the run header chip). The host answers with the run's summary, which carries the new mode. */
export async function setRunMode(agentId: string, mode: PermissionMode, opts?: { confirmBypass?: boolean }): Promise<AgentSummary> {
  const summary = await client.agentSetPermission(agentId, mode, opts);
  upsertSummary(summary);
  return summary;
}

/** Banners the user closed (not persisted: a closed banner stays closed for this window only). */
const [dismissed, setDismissed] = createSignal<Record<string, true>>({});
export const bannerDismissed = (agentId: string, seq: number): boolean => !!dismissed()[`${agentId}:${seq}`];
export const dismissBanner = (agentId: string, seq: number): void => void setDismissed((d) => ({ ...d, [`${agentId}:${seq}`]: true }));

export async function answerQuestion(agentId: string, reqId: string, answer: QuestionAnswer): Promise<void> {
  const view = views()[agentId];
  if (view) putView(markQuestionAnswered(view, reqId, answer));
  await client.agentAnswerQuestion(agentId, reqId, answer);
}

export const rewindRun = (agentId: string): Promise<void> => client.agentRewind(agentId);
export const searchRepoFiles = (repoId: string, query: string, limit = 8): Promise<string[]> => client.agentRepoFiles(repoId, query, limit);

/** Test helper: forget everything. */
export function resetAgents(): void {
  unsubscribe?.();
  unsubscribe = undefined;
  batch(() => {
    setSummaries([]);
    setViews({});
    setRoleList([]);
    setSelected(null);
    setInterrupting({});
    setDrafts({});
    setLoadError(undefined);
    setLoaded(false);
    setSpoken("");
    setDismissed({});
    resetStarting();
  });
  pending = new Map();
  rowCache.clear();
}
