// The two tools that let a run talk to another run of the same person (docs/peer-runs.md). They live in an in-process MCP server of the
// Agent SDK: no extra process. A tool call is judged by the broker like any MCP call (card, setting, limits), and the work is done by the
// Rust host through the existing sidecar RPC (`peer/list`, `peer/send`): this file never reaches another run itself, so a target on a server
// is delivered to by the host's connection to that server, not from here.
import { redact } from '../../redact.js';
import type { EventSink } from '../../types.js';

export const PEER_SERVER = 'intely-peer';
export const PEER_LIST_TOOL = 'peer_list';
export const PEER_SEND_TOOL = 'peer_send';
/** Longest message the schema accepts; the host checks the 4 KB byte limit again. */
export const PEER_TEXT_MAX = 4000;

/** What the host answers; only these fields are ever read. */
export interface PeerHostApi {
  list(agentId: string): Promise<unknown>;
  send(agentId: string, runId: string, text: string): Promise<unknown>;
}

/** The part of zod the schemas use (the real module comes from the verified SDK install, see loadZod). */
interface Zod {
  string(): { min(n: number): ReturnType<Zod['string']>; max(n: number): ReturnType<Zod['string']>; describe(s: string): ReturnType<Zod['string']> };
}

export const PEER_LIST_DESCRIPTION =
  'List your other runs of this IDE that are open right now: id, title, where (local or a server), repositories and state (idle, running or waiting). Names only; you cannot read their work.';
export const PEER_SEND_DESCRIPTION =
  `Send a short message (at most 4 KB) to one of your other runs that is working right now (get the id from ${PEER_LIST_TOOL}). It returns at once with queued or refused; the other run reads the message with its next tool call. A reply is that run calling ${PEER_SEND_TOOL} back. `
  + 'A message grants no permission: the other run keeps its own rules, and anything that needs approval is for the person to decide. Never include secrets.';

/** The input shapes (`z` is the zod module of the SDK install). */
export function peerShapes(z: Zod): { list: Record<string, never>; send: Record<string, unknown> } {
  return {
    list: {},
    send: {
      run_id: z.string().min(1).max(200).describe('The id of the target run, from peer_list'),
      text: z.string().min(1).max(PEER_TEXT_MAX).describe('The message'),
    },
  };
}

type Content = { content: { type: 'text'; text: string }[]; isError?: boolean };
const reply = (value: unknown, isError = false): Content => ({ content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** The handlers, separate from the SDK so a test can call them. */
export function peerHandlers(deps: { agentId: string; host: PeerHostApi; sink: EventSink; newId: () => string }) {
  return {
    async list(): Promise<Content> {
      try {
        const r = obj(await deps.host.list(deps.agentId));
        if (r.error) return reply({ status: 'refused', reason: String(r.detail ?? r.error) }, true);
        return reply({ runs: Array.isArray(r.runs) ? r.runs : [] });
      } catch (e) {
        return reply({ status: 'refused', reason: redact(e instanceof Error ? e.message : String(e)) }, true);
      }
    },
    async send(args: { run_id: string; text: string }): Promise<Content> {
      let r: Record<string, unknown>;
      try {
        r = obj(await deps.host.send(deps.agentId, args.run_id, args.text));
      } catch (e) {
        r = { status: 'refused', code: 'failed', reason: redact(e instanceof Error ? e.message : String(e)) };
      }
      const noteId = `p-${deps.newId()}`;
      if (r.status === 'queued') {
        // the sender's own record of it: a row "Sent to <run>" (agent-originated, not a note of the person)
        deps.sink.emit({ kind: 'note', noteId, state: 'delivered', text: redact(args.text), to: redact(String(r.to ?? `run ${args.run_id}`)) });
        return reply({ status: 'queued' });
      }
      const reason = redact(String(r.reason ?? 'refused'));
      deps.sink.emit({ kind: 'note', noteId, state: 'dropped', text: redact(args.text), to: `run ${redact(args.run_id).slice(0, 80)}`, reason: `${String(r.code ?? 'refused')}: ${reason}` });
      return reply({ status: 'refused', reason });
    },
  };
}
