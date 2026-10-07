import { batch, createSignal } from "solid-js";
import { ipc as defaultIpc, type Ipc } from "../../ipc";
import type { AgentEvent } from "../../store/agent-types";

export type LogStatus = "loading" | "ready" | "expired" | "error";

export interface RunLog {
  status: LogStatus;
  events: AgentEvent[];
  error?: string;
}

const [logs, setLogs] = createSignal<Record<string, RunLog>>({});
/** Live events of runs whose log is still loading; merged in once it arrives. */
const waiting = new Map<string, AgentEvent[]>();
let unsubscribe: (() => void) | undefined;

export const runLog = (runId: string): RunLog | undefined => logs()[runId];

/** Appends the events newer than what the log already has (the live stream and a reload overlap). */
export function mergeEvents(base: readonly AgentEvent[], incoming: readonly AgentEvent[]): AgentEvent[] {
  let last = base.at(-1)?.seq ?? 0;
  const next = base.slice();
  for (const e of incoming) {
    if (e.seq <= last) continue;
    next.push(e);
    last = e.seq;
  }
  return next;
}

function onLive(events: AgentEvent[]): void {
  setLogs((all) => {
    let next = all;
    for (const e of events) {
      const cur = next[e.agentId];
      if (!cur) continue;
      if (cur.status === "loading") waiting.set(e.agentId, [...(waiting.get(e.agentId) ?? []), e]);
      else if (cur.status === "ready") next = { ...next, [e.agentId]: { ...cur, events: mergeEvents(cur.events, [e]) } };
    }
    return next;
  });
}

const errorCode = (e: unknown): string | undefined => (typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined);
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String((e as { message?: string }).message ?? e));

/** A run in this session answers `agentHistory`; a finished one from an earlier session comes from the runs history. */
async function fetchEvents(runId: string, client: Ipc): Promise<AgentEvent[]> {
  const live = await client.agentHistory(runId).catch(() => [] as AgentEvent[]);
  return live.length > 0 ? live : client.runs.events(runId);
}

/** Loads the log once and keeps it current from the live event stream. A second call for a loaded run does nothing unless `force` is set. */
export async function loadRunLog(runId: string, opts: { client?: Ipc; force?: boolean } = {}): Promise<void> {
  const client = opts.client ?? defaultIpc;
  const cur = logs()[runId];
  if (cur && !opts.force && cur.status !== "error") return;
  unsubscribe ??= client.onAgentEvents(onLive);
  setLogs((all) => ({ ...all, [runId]: { status: "loading", events: [] } }));
  try {
    const events = await fetchEvents(runId, client);
    batch(() => {
      setLogs((all) => ({ ...all, [runId]: { status: "ready", events: mergeEvents(events, waiting.get(runId) ?? []) } }));
      waiting.delete(runId);
    });
  } catch (e) {
    waiting.delete(runId);
    const code = errorCode(e);
    setLogs((all) => ({ ...all, [runId]: { status: code === "transcriptExpired" || code === "notFound" ? "expired" : "error", events: [], error: errorText(e) } }));
  }
}

/** Test helper: forget everything. */
export function resetRunLogs(): void {
  unsubscribe?.();
  unsubscribe = undefined;
  waiting.clear();
  setLogs({});
}
