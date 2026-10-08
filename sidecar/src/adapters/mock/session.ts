// Scripted provider: same AgentSession interface as the real adapters, no CLI. Drives the UI and the Inspector in dev and tests.
import type { Actor, AgentSession, DecidedBy, EventSink, PermissionAnswer, PermissionMode, PolicyClient, PolicyDecision, SessionNote, SessionSpec, StopReason, ToolKind, UserInput } from '../../types.js';
import { intentFor } from '../claude-sdk/intent.js';
import { effortOf, isUnattended, NoteError } from '../../abstract.js';
import { LEAD, NoteQueue } from '../../note-queue.js';
import { offeredOptions, PLAN_MODES, planPayload } from '../../permission-options.js';
import { parseScript, type Step } from './script.js';

type Waiter = { resolve: (a: PermissionAnswer) => void };

/** Same text as the Claude gate gives the model for a refusal, so the UI parses one format. */
const denyText = (d: PolicyDecision) => `INTELY-HARDSTOP: ${d.reason ?? 'refused by policy'} (${d.by}${d.rule ? `, ${d.rule}` : ''})`;

const fill = (v: unknown, cwd: string): unknown => {
  if (typeof v === 'string') return v.split('{{cwd}}').join(cwd);
  if (Array.isArray(v)) return v.map((x) => fill(x, cwd));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, cwd)]));
  return v;
};

export class MockSession implements AgentSession {
  readonly nativeId: string;
  private turns: Step[][];
  private turnNo = 0;
  private running?: Promise<void>;
  private aborted = false;
  private wake?: () => void;
  private waiting = new Map<string, Waiter>();
  private speed: number;
  private cwd: string;
  /** The IDE mode the session holds; `setPermission` and an approved plan change it, like the Claude adapter. */
  private mode: PermissionMode;
  /** Delegations in flight: Agent tool id -> the actor its calls carry. */
  private agents = new Map<string, Actor>();
  /** Agent tool ids the broker refused: the role never started, so the calls the script scripts for it are not played. */
  private refused = new Set<string>();
  /** Notes the user added to the lead or a running sub-agent; handed over (reported as delivered) at that target's next tool call. */
  private notes: NoteQueue;
  /** Scripted `Agent`/`Task` calls that have started and have no result yet: the sub-agents a note can be addressed to. */
  private openAgents = new Set<string>();

  constructor(private spec: SessionSpec, private sink: EventSink, scriptText: string, private policy?: PolicyClient) {
    this.notes = new NoteQueue(sink);
    this.turns = parseScript(scriptText);
    if (!this.turns.length) throw new Error('mock script has no steps');
    this.speed = spec.mock?.speed ?? 1;
    this.cwd = spec.cwd;
    this.mode = spec.role.permission;
    this.nativeId = spec.resume?.nativeId ?? spec.sessionId ?? `mock-${spec.agentId}`;
    sink.emit({ kind: 'session.started', nativeId: this.nativeId, model: spec.role.model, effective: { effort: effortOf(spec.role.effort), permission: spec.role.permission } });
    // like the real adapter: the roles the lead may hand work to, once, without the prompts
    if (spec.delegates?.length) sink.emit({ kind: 'session.info', nativeId: this.nativeId, delegates: spec.delegates.map(({ prompt: _prompt, ...info }) => info) });
  }

  prompt(_input: UserInput): void {
    if (this.running) return;
    const steps = this.turns[Math.min(this.turnNo++, this.turns.length - 1)];
    this.aborted = false;
    this.running = this.run(steps).finally(() => { this.running = undefined; });
  }

  async interrupt(): Promise<void> {
    if (!this.running) return;
    this.aborted = true;
    this.wake?.();
    for (const [id, w] of [...this.waiting]) { this.waiting.delete(id); w.resolve({ outcome: 'cancelled' }); }
    await this.running;
  }

  answer(reqId: string, answer: PermissionAnswer): void {
    const w = this.waiting.get(reqId);
    if (!w) return;
    this.waiting.delete(reqId);
    w.resolve(answer);
  }

  async close(): Promise<void> { await this.interrupt(); }

  /** A note for the lead or a running sub-agent of the turn in progress; it is reported as delivered at that target's next scripted tool call. */
  note(n: SessionNote): void {
    if (!this.running) throw new NoteError('noTurn');
    if (n.parentToolId && !this.openAgents.has(n.parentToolId) && !this.agents.has(n.parentToolId)) throw new NoteError('unknownTarget', 'that sub-agent is not running');
    this.notes.add(n);
  }

  /** A scripted tool call of `parent`'s sub-agent (or of the lead) is starting: the notes waiting for that target ride on it. */
  private deliver(parent: string | undefined, toolId: string): void {
    this.notes.take(parent || LEAD, toolId);
  }

  /** The `Agent`/`Task` call `id` has its result: its sub-agent is over, and so are the notes meant for it. */
  private agentDone(id: string): void {
    this.openAgents.delete(id);
    this.notes.dropTarget(id, 'finished');
  }

  /** Accepts all five modes (the mock is a Claude stand-in for the UI e2e); Rust has already switched its side. */
  async setPermission(mode: PermissionMode): Promise<void> {
    if (mode === this.mode) return;
    this.mode = mode;
    this.sink.emit({ kind: 'session.info', nativeId: this.nativeId, effective: { permission: mode, reason: 'user' } });
  }

  private delay(ms: number): Promise<void> {
    if (this.aborted) return Promise.resolve();
    const scaled = this.speed > 0 ? ms / this.speed : 0;
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => { this.wake = undefined; resolve(); }, scaled);
      this.wake = () => { clearTimeout(t); this.wake = undefined; resolve(); };
    });
  }

  private ask(reqId: string): Promise<PermissionAnswer> {
    return new Promise((resolve) => { this.waiting.set(reqId, { resolve }); });
  }

  /**
   * Asks the REAL policy broker about one call (so the denials in a mock run are the broker's, not the script's) and plays the outcome:
   * allow -> `ok`, deny -> a permission pair resolved at once plus a denied result, ask -> a card that waits for the answer.
   * `finish` false leaves an allowed tool open (the Agent tool, whose result comes at `enddelegate`). Returns whether the call was allowed.
   */
  private async judged(toolId: string, name: string, toolKind: ToolKind, input: unknown, parent: string | undefined, actor: Actor | undefined, ms: number, output?: unknown, finish = true): Promise<boolean> {
    const intent = intentFor(name, input, parent, actor);
    this.sink.emit({ kind: 'tool.start', toolId, name, toolKind, input: input as Record<string, unknown>, ...(parent ? { parentToolId: parent } : {}) });
    let d: PolicyDecision;
    try {
      d = this.policy ? await this.policy.decide({ agentId: this.spec.agentId, toolId, provider: this.spec.provider, intent }) : { decision: 'allow', by: 'default' };
    } catch (e) {
      d = { decision: 'deny', by: 'failClosed', reason: `policy unavailable: ${(e as Error).message}` };
    }
    const reqId = `perm-${toolId}`;
    // like the Claude gate: Rust never asks in an unattended run, so an Ask there is an internal error, not a card
    if (d.decision === 'ask' && isUnattended(this.mode)) d = { decision: 'deny', by: 'failClosed', reason: 'the policy asked in an unattended mode (internal error)', rule: 'policy.ask-in-unattended' };
    if (d.decision === 'deny') {
      this.sink.emit({ kind: 'permission.request', reqId, toolId, intent, options: ['deny'] });
      this.sink.emit({ kind: 'permission.resolved', reqId, outcome: 'deny', by: d.by });
      this.sink.emit({ kind: 'tool.result', toolId, status: 'denied', output: denyText(d), durationMs: 0 });
      return false;
    }
    if (d.decision === 'ask') {
      this.sink.emit({ kind: 'permission.request', reqId, toolId, intent, options: offeredOptions(d), ...(d.sessionAllow ? { sessionAllow: d.sessionAllow } : {}) });
      const a = await this.ask(reqId);
      this.sink.emit({ kind: 'permission.resolved', reqId, outcome: a.outcome, by: 'user' });
      if (a.outcome !== 'allow') { if (!this.aborted) this.sink.emit({ kind: 'tool.result', toolId, status: 'denied', output: a.message ?? 'The user declined this action.', durationMs: 0 }); return false; }
    }
    this.deliver(parent, toolId);
    if (!finish) return true;
    await this.delay(ms);
    if (this.aborted) return true;
    this.sink.emit({ kind: 'tool.result', toolId, status: 'ok', ...(output !== undefined ? { output: String(output) } : {}), durationMs: ms });
    return true;
  }

  /**
   * The lead's ExitPlanMode, judged by the REAL broker (a Plan run answers `ask other.exit-plan`): the approval card carries the plan and the
   * working modes; approving continues in the chosen mode (`session.info planApproved`), rejecting returns the user's text to the "model", which
   * revises and asks once more. Returns false when the turn was cancelled meanwhile.
   */
  private async exitPlan(s: Step): Promise<boolean> {
    const say = async (id: string, text: string) => {
      this.sink.emit({ kind: 'text.delta', messageId: id, text });
      this.sink.emit({ kind: 'text.done', messageId: id, text });
    };
    for (let round = 1; round <= 2 && !this.aborted; round++) {
      const toolId = round === 1 ? String(s.id) : `${s.id}-r${round}`;
      const input = { plan: String(s.plan ?? '') };
      const intent = intentFor('ExitPlanMode', input);
      this.sink.emit({ kind: 'tool.start', toolId, name: 'ExitPlanMode', toolKind: 'other', input });
      let d: PolicyDecision;
      try {
        d = this.policy ? await this.policy.decide({ agentId: this.spec.agentId, toolId, provider: this.spec.provider, intent }) : { decision: 'allow', by: 'default' };
      } catch (e) {
        d = { decision: 'deny', by: 'failClosed', reason: `policy unavailable: ${(e as Error).message}` };
      }
      const reqId = `perm-${toolId}`;
      if (d.decision === 'deny') {
        this.sink.emit({ kind: 'permission.request', reqId, toolId, intent, options: ['deny'] });
        this.sink.emit({ kind: 'permission.resolved', reqId, outcome: 'deny', by: d.by });
        this.sink.emit({ kind: 'tool.result', toolId, status: 'denied', output: denyText(d), durationMs: 0 });
        return true;
      }
      if (d.decision === 'allow') { // not a Plan run: nothing to approve
        this.sink.emit({ kind: 'tool.result', toolId, status: 'ok', output: 'Plan accepted', durationMs: 0 });
        return true;
      }
      this.sink.emit({ kind: 'permission.request', reqId, toolId, intent, options: ['allow_once', 'deny'], ...planPayload(input.plan) });
      const a = await this.ask(reqId);
      this.sink.emit({ kind: 'permission.resolved', reqId, outcome: a.outcome, by: 'user' });
      if (a.outcome === 'cancelled') return false;
      if (a.outcome === 'allow') {
        const mode = a.mode && PLAN_MODES.includes(a.mode) ? a.mode : 'ask';
        this.mode = mode;
        this.sink.emit({ kind: 'session.info', nativeId: this.nativeId, effective: { permission: mode, reason: 'planApproved' } });
        this.sink.emit({ kind: 'tool.result', toolId, status: 'ok', output: 'Plan accepted', durationMs: 0 });
        await say(`${s.id}:go`, `Continuing in ${mode}.`);
        return true;
      }
      const message = a.message ?? 'The user wants changes to the plan.';
      this.sink.emit({ kind: 'tool.result', toolId, status: 'error', output: message, durationMs: 0 });
      await say(`${s.id}:rev${round}`, round === 1 ? `Revising: ${message}.` : 'The plan was not approved.');
    }
    return !this.aborted;
  }

  private async run(steps: Step[]): Promise<void> {
    const labels = new Map<string, number>();
    steps.forEach((s, i) => { if (s.op === 'label') labels.set(String(s.name), i); });
    let stop: StopReason = 'endTurn';
    let i = 0;
    outer: while (i < steps.length && !this.aborted) {
      const s = steps[i++];
      await this.delay(s.dt ?? 0);
      if (this.aborted) break;
      switch (s.op) {
        case 'text': {
          const text = String(s.text);
          const chunk = Math.max(1, Number(s.chunk ?? text.length));
          for (let p = 0; p < text.length && !this.aborted; p += chunk) {
            this.sink.emit({ kind: 'text.delta', messageId: String(s.id), text: text.slice(p, p + chunk), ...(s.parent ? { parentToolId: s.parent } : {}) });
            if (p + chunk < text.length) await this.delay(s.every ?? 15);
          }
          if (!this.aborted) this.sink.emit({ kind: 'text.done', messageId: String(s.id), text, ...(s.parent ? { parentToolId: s.parent } : {}) });
          break;
        }
        case 'think':
          this.sink.emit({ kind: 'thinking.delta', messageId: String(s.id), text: String(s.text) });
          break;
        case 'start':
          this.sink.emit({ kind: 'tool.start', toolId: String(s.id), name: String(s.name), toolKind: s.toolKind ?? 'other', input: s.input ?? {}, ...(s.parent ? { parentToolId: s.parent } : {}) });
          this.deliver(s.parent, String(s.id));
          if (s.name === 'Agent' || s.name === 'Task') this.openAgents.add(String(s.id));
          break;
        case 'tool': {
          this.sink.emit({ kind: 'tool.start', toolId: String(s.id), name: String(s.name), toolKind: s.toolKind ?? 'other', input: s.input ?? {}, ...(s.parent ? { parentToolId: s.parent } : {}) });
          this.deliver(s.parent, String(s.id));
          await this.delay(s.ms ?? 50);
          if (this.aborted) break;
          this.sink.emit({ kind: 'tool.result', toolId: String(s.id), status: s.status ?? 'ok', ...(s.output !== undefined ? { output: String(s.output) } : {}), ...(s.diff ? { diff: s.diff } : {}), durationMs: s.ms ?? 50 });
          break;
        }
        case 'ask': {
          const reqId = String(s.reqId ?? `perm-${s.id}`);
          this.sink.emit({ kind: 'permission.request', reqId, toolId: String(s.id), intent: s.intent, options: s.by ? ['deny'] : ['allow_once', 'deny'] });
          let outcome: PermissionAnswer['outcome'];
          let by: DecidedBy = 'user';
          if (s.by) { outcome = s.outcome ?? 'deny'; by = String(s.by) as DecidedBy; }
          else outcome = (await this.ask(reqId)).outcome;
          this.sink.emit({ kind: 'permission.resolved', reqId, outcome, by });
          const target = outcome === 'allow' ? s.onAllow : s.onDeny;
          if (outcome === 'cancelled') { stop = 'cancelled'; break outer; }
          if (target !== undefined) i = labels.get(String(target)) ?? i;
          break;
        }
        case 'question': {
          const reqId = String(s.reqId ?? `q-${s.id}`);
          this.sink.emit({ kind: 'question.request', reqId, toolId: String(s.id), prompt: String(s.prompt), options: s.options ?? [] });
          const a = await this.ask(reqId);
          if (a.outcome === 'cancelled') { stop = 'cancelled'; break outer; }
          break;
        }
        case 'delegate': {
          // the lead's Agent call goes through the broker too: an unknown type, the cap and isolation are refused for real
          const id = String(s.id);
          const input = { subagent_type: s.role, description: s.description ?? '', prompt: s.prompt ?? s.description ?? '', run_in_background: false };
          if (await this.judged(id, 'Agent', 'other', input, undefined, undefined, 0, undefined, false)) {
            this.agents.set(id, { agentId: `sub-${id}`, role: String(s.role) });
            this.sink.emit({ kind: 'tool.update', toolId: id, status: 'running', output: `${s.role}: ${s.description ?? ''}` });
          } else {
            this.refused.add(id);
          }
          break;
        }
        case 'call': {
          // `role` overrides the actor (to play an actor the run does not know); otherwise the delegate of `parent` makes the call
          const parent = s.parent ? String(s.parent) : undefined;
          if (parent && this.refused.has(parent)) break;
          const actor = s.role ? { agentId: `sub-${parent ?? 'x'}`, role: String(s.role) } : parent ? this.agents.get(parent) : undefined;
          await this.judged(String(s.id), String(s.name), (s.toolKind ?? 'other') as ToolKind, fill(s.input ?? {}, this.cwd), parent, actor, s.ms ?? 30, s.output);
          break;
        }
        case 'enddelegate': {
          const id = String(s.id);
          if (this.agents.delete(id)) { this.agentDone(id); this.sink.emit({ kind: 'tool.result', toolId: id, status: 'ok', output: String(s.output ?? ''), durationMs: s.ms ?? 100 }); }
          break;
        }
        case 'exitplan':
          if (!(await this.exitPlan(s))) { stop = 'cancelled'; break outer; }
          break;
        case 'emit':
          if (s.event?.kind === 'tool.result' && typeof s.event.toolId === 'string') this.agentDone(s.event.toolId);
          this.sink.emit(s.event);
          break;
        case 'usage': this.sink.emit({ kind: 'usage', usage: s.usage }); break;
        case 'error': this.sink.emit({ kind: 'error', class: s.class ?? 'provider', message: String(s.message), retryable: !!s.retryable }); break;
        case 'status': this.sink.emit({ kind: 'status', state: s.state, ...(s.retryAfterMs !== undefined ? { retryAfterMs: s.retryAfterMs } : {}), ...(s.scope ? { scope: s.scope } : {}) }); break;
        case 'plan': this.sink.emit({ kind: 'plan', items: s.items }); break;
        case 'goto': i = labels.get(String(s.label)) ?? steps.length; break;
        case 'end': stop = s.stopReason ?? 'endTurn'; break outer;
        default: break; // label, wait
      }
    }
    this.notes.dropAll(this.aborted ? 'cancelled' : 'turnEnded'); // before turn.end, like the Claude adapter
    this.openAgents.clear();
    this.sink.emit({ kind: 'turn.end', stopReason: this.aborted ? 'cancelled' : stop });
  }
}
