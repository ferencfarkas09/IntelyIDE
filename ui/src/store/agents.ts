import { batch, createSignal } from "solid-js";
import { ipc as defaultIpc, type Ipc } from "../ipc";
import { announcement } from "../components/chat/format";
import { emptyView, markPermissionAnswered, markPermissionRefused, markQuestionAnswered, pendingPermissions, pendingQuestions, reduceEvents, runStatus, type AgentView } from "./agent-reducer";
import type { FileSelection } from "../modules/attachments/types";
import type { AgentAttachment, AgentEvent, AgentStartRequest, AgentSummary, McpServerInfo, PermissionDecision, PermissionMode, QuestionAnswer, RoleInfo, RunStatus } from "./agent-types";

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
export const agentRow = (id: string | null): AgentRow | undefined => (id ? agentRows().find((r) => r.agentId === id) : undefined);
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
  setSelected(agentId);
  if (agentId) await loadHistory(agentId);
}

export async function startRun(req: AgentStartRequest, opts?: { runWithoutSafetyNet?: boolean; confirmBypass?: boolean }): Promise<AgentSummary> {
  const summary = await client.agentStart(req, opts);
  batch(() => {
    pending.delete(summary.agentId);
    if (!views()[summary.agentId]) putView(emptyView(summary.agentId));
    upsertSummary(summary);
    setSelected(summary.agentId);
  });
  return summary;
}

export async function sendMessage(agentId: string, text: string, attachments?: AgentAttachment[], files?: FileSelection): Promise<void> {
  await client.agentSend(agentId, text, attachments?.length ? attachments : undefined, files);
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
  });
  pending = new Map();
}
