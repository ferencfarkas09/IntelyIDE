// Tool gate: SDK PreToolUse hook (policy/decide FIRST, deny on timeout or a malformed reply) and canUseTool (UI prompts,
// AskUserQuestion). Separate from the session so the fail-closed behaviour is testable without a CLI process.
import { randomUUID } from 'node:crypto';
import type { CanUseTool, HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { isUnattended } from '../../abstract.js';
import { offeredOptions, PLAN_MODES, planPayload } from '../../permission-options.js';
import type { Actor, EventSink, PermissionAnswer, PermissionMode, PolicyClient, PolicyDecision, ProviderId, ToolIntent } from '../../types.js';
import { cliPromptMessage, judgeCliPrompt } from './cli-prompts.js';
import { permissionModeFor } from './facts.js';
import { intentFor } from './intent.js';
import type { Raw } from './map.js';
import { PLAN_FILE_HINT } from './notes.js';

export const DENY_MARK = 'INTELY-HARDSTOP';

/** Prefix of the `error {class:'policy'}` message the canary emits; the host reads it as the `delegationDisabled` kill switch. */
export const CANARY_MARK = 'INTELY-DELEGATION-CANARY';

const SPAWN_TOOLS = new Set(['Agent', 'Task']);

export const PLAN_REJECT_DEFAULT = 'The user wants changes to the plan. Revise it and call ExitPlanMode again.';
/** CLI modes this IDE never asks for: seeing one in a hook input means the CLI left the mode the IDE set (6.3 item 4). */
const DRIFT_MODES = new Set(['bypassPermissions', 'dontAsk', 'auto']);

/**
 * The input of an allowed `Agent` call with its dangerous levers removed ((design notes: roles-orchestration-spec) 5.4): the role
 * decides the model, the call runs in the foreground, no worktree/team/mode. A convenience on top of the broker, which
 * already denies `model`, `isolation` and `run_in_background: true` itself.
 */
export function rewriteAgentInput(input: unknown): Record<string, unknown> {
  const { model: _m, isolation: _i, team_name: _t, mode: _mode, ...rest } = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return { ...rest, run_in_background: false };
}

/**
 * Any run, delegating or not: an `Agent` call runs in the foreground. The CLI backgrounds it by default, which would let the lead end its
 * turn while the sub-agent works on outside every turn (the run reads Done, Stop has nothing to stop). Nothing else of the call is touched.
 */
export function foregroundAgentInput(input: unknown): Record<string, unknown> {
  return { ...(input && typeof input === 'object' ? (input as Record<string, unknown>) : {}), run_in_background: false };
}

type Pending = { toolId: string; resolve: (a: PermissionAnswer) => void };
/** A cached Rust verdict, stamped with the mode epoch it was decided under (6.3 item 8). */
type Known = { d: PolicyDecision; epoch: number; intent: ToolIntent };

export interface GateOptions {
  agentId: string;
  provider: ProviderId;
  policy: PolicyClient;
  sink: EventSink;
  denied: Set<string>;
  delegating?: boolean;
  onCanary?: () => void;
  /** The IDE mode the session holds right now (it changes live). The unattended guard keys on it, like Rust keys on the run mode. */
  mode: () => PermissionMode;
  /** An ExitPlanMode approval chose the mode the run continues in: the session's own view follows BEFORE the CLI is answered. */
  noteMode?: (mode: PermissionMode) => void;
  /** The last assistant text block of the turn: the plan when the CLI's ExitPlanMode input carries none (spike Q4: `{}`). */
  lastText?: () => string | undefined;
  /** Working directory of the run: relative paths of a CLI prompt are resolved against it. */
  cwd?: string;
  /** The run directories (cwd plus the added directories): what Automatic holds a CLI boundary prompt against. */
  runDirs?: readonly string[];
  /** The plan directory the host asked the CLI to use (it may be ignored by the CLI, see settings.ts): a refused write there gets the plan hint. */
  planDir?: string;
}

const PLAN_FILE = /(?:^|\/)\.claude\/plans\/[^/]+$/;
const FILE_WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export class ToolGate {
  private pending = new Map<string, Pending>();
  private decisions = new Map<string, Known>();
  /** Bumped by every mode change; a cached decision of an older epoch is decided again by `canUseTool` (6.3 item 8). */
  private epoch = 0;
  private askGuardTold = false;
  private driftTold = false;
  private cliPromptTold = new Set<string>();
  /** agent_id -> agent_type of the sub-agents in flight (SubagentStart adds, SubagentStop removes). */
  private agentTypes = new Map<string, string>();
  private active = new Set<string>();
  /**
   * `Agent` calls of the lead that have no result yet. A sub-agent counts as in flight only while one of these is open: a sub-agent
   * that runs out of turns (or is cut off) never reports SubagentStop, and without this a stale `active` entry made EVERY later call
   * of the lead an unknown actor (`?`) that the broker refuses.
   */
  private agentCalls = new Set<string>();
  /** Tool ids that were judged without an actor (the lead) and tool_use ids seen inside a sub-agent: their intersection trips the canary. */
  private actorless = new Set<string>();
  private subagentToolIds = new Set<string>();
  /**
   * `tool_use` ids that the lead's own messages carried (no parent): a call of the lead that runs next to a sub-agent which is already in
   * flight (two `Agent` calls in one message, `Read` + `Agent`) has no agent_id either, and is the lead, not an unknown actor.
   */
  private leadToolIds = new Set<string>();
  private tripped = false;

  /**
   * `denied` is shared with the event mapper so a refused tool's error result is reported as "denied". `delegating` turns the
   * actor bookkeeping on; `onCanary` runs once when a sub-agent's tool call reached policy without an actor.
   */
  constructor(private o: GateOptions) {}

  get activeSubagents(): number { return this.active.size; }
  get canaryTripped(): boolean { return this.tripped; }

  /** The mode changed (live switch, plan approval, or a repeat of the current mode after an MCP tightening): older verdicts are stale. */
  bumpEpoch(): void { this.epoch++; }

  readonly subagentStart: HookCallback = async (input) => {
    if (input.hook_event_name === 'SubagentStart') {
      this.active.add(input.agent_id);
      this.agentTypes.set(input.agent_id, input.agent_type);
    }
    return { continue: true };
  };

  readonly subagentStop: HookCallback = async (input) => {
    if (input.hook_event_name === 'SubagentStop') {
      this.active.delete(input.agent_id);
      this.agentTypes.delete(input.agent_id);
    }
    return { continue: true };
  };

  /**
   * Who made the call. The model cannot set this: it comes from the hook input. Fail closed: no agent_id while a sub-agent is in
   * flight is NOT "the lead" but an actor the broker does not know (`?`), so a missing field can only deny.
   */
  private actorFor(agentId?: string, agentType?: string, toolId?: string): Actor | undefined {
    if (agentId) return { agentId, role: agentType ?? this.agentTypes.get(agentId) ?? '?' };
    if (this.o.delegating && this.active.size > 0 && this.agentCalls.size > 0 && !this.isLeadCall(toolId)) return { agentId: '?', role: '?' };
    return undefined;
  }

  /** Positive evidence only: the call's `tool_use` came in a message of the lead and was never seen inside a sub-agent. */
  private isLeadCall(toolId?: string): boolean {
    return !!toolId && this.leadToolIds.has(toolId) && !this.subagentToolIds.has(toolId);
  }

  /** A message of the lead (no parent_tool_use_id) contained this tool_use. */
  noteLeadToolUse(toolId: string): void {
    this.leadToolIds.add(toolId);
    if (this.leadToolIds.size > 512) this.leadToolIds.delete(this.leadToolIds.keys().next().value as string);
  }

  /**
   * The lead received the result of a tool call (a message of the lead, not from inside a sub-agent). When the last open `Agent` call
   * has returned no sub-agent is in flight any more, whatever SubagentStop did or did not report.
   */
  toolResult(toolUseId: string): void {
    if (!this.agentCalls.delete(toolUseId)) return;
    if (this.agentCalls.size === 0) this.clearSubagents();
  }

  /** The turn is over: every sub-agent runs in the foreground (a background call is refused), so none can still be running. */
  turnEnded(): void {
    this.agentCalls.clear();
    this.clearSubagents();
  }

  private clearSubagents(): void {
    this.active.clear();
    this.agentTypes.clear();
  }

  /** An assistant message inside a sub-agent (parent_tool_use_id set) contained this tool_use. */
  noteSubagentToolUse(toolId: string): void {
    this.subagentToolIds.add(toolId);
    if (this.subagentToolIds.size > 512) this.subagentToolIds.delete(this.subagentToolIds.keys().next().value as string);
    if (this.actorless.has(toolId)) this.trip();
  }

  private trip(): void {
    if (this.tripped) return;
    this.tripped = true;
    this.o.onCanary?.();
  }

  private async decide(toolId: string, tool: string, input: unknown, actor?: Actor, parentToolId?: string): Promise<PolicyDecision> {
    const known = this.decisions.get(toolId);
    if (known && known.epoch === this.epoch) return known.d;
    const epoch = this.epoch; // a switch while Rust is still answering leaves this entry stale on purpose
    const intent = intentFor(tool, input, parentToolId, actor);
    let d: PolicyDecision;
    if (this.tripped) {
      d = { decision: 'deny', by: 'failClosed', reason: 'delegation was switched off: a sub-agent call could not be attributed to its role' };
    } else {
      try {
        d = await this.o.policy.decide({ agentId: this.o.agentId, toolId, provider: this.o.provider, intent });
        if (!d || !['allow', 'deny', 'ask'].includes(d.decision)) d = { decision: 'deny', by: 'failClosed', reason: 'malformed policy decision' };
      } catch (e) {
        d = { decision: 'deny', by: 'failClosed', reason: `policy unavailable: ${(e as Error).message}` };
      }
    }
    d = this.unattendedGuard(d);
    this.decisions.set(toolId, { d, epoch, intent });
    if (this.decisions.size > 512) this.decisions.delete(this.decisions.keys().next().value as string);
    if (this.o.delegating && !actor) {
      this.actorless.add(toolId);
      if (this.actorless.size > 512) this.actorless.delete(this.actorless.keys().next().value as string);
      if (this.subagentToolIds.has(toolId)) this.trip();
    }
    return d;
  }

  /**
   * Rust never answers Ask in an unattended run (2.4), so a card there would hang a run the user was told never asks. The guard keys on
   * the RUN mode, the predicate Rust uses; it covers only a rule added later without the invariant (a read-only delegate's Ask is
   * already a `delegate.read-only` denial in Rust).
   */
  private unattendedGuard(d: PolicyDecision): PolicyDecision {
    if (d.decision !== 'ask' || !isUnattended(this.o.mode())) return d;
    if (!this.askGuardTold) {
      this.askGuardTold = true;
      this.o.sink.emit({ kind: 'error', class: 'policy', message: 'The policy asked in an unattended mode (internal error); the call was refused instead of waiting for a card nobody can see.', retryable: false });
    }
    return { decision: 'deny', by: 'failClosed', reason: 'the policy asked in an unattended mode (internal error)', rule: 'policy.ask-in-unattended' };
  }

  private denyText(d: PolicyDecision, tool?: string, input?: unknown): string {
    return `${DENY_MARK}: ${d.reason ?? 'refused by policy'} (${d.by}${d.rule ? `, ${d.rule}` : ''})${this.planFileHint(tool, input)}`;
  }

  /** A refused write of the CLI's plan file: tell the model what works instead (the CLI cannot be pointed at a directory outside the project). */
  private planFileHint(tool?: string, input?: unknown): string {
    if (!tool || !FILE_WRITERS.has(tool) || !input || typeof input !== 'object') return '';
    const p = (input as Record<string, unknown>).file_path;
    if (typeof p !== 'string') return '';
    const under = this.o.planDir && (p === this.o.planDir || p.startsWith(`${this.o.planDir}/`));
    return under || PLAN_FILE.test(p) ? ` ${PLAN_FILE_HINT}` : '';
  }

  private audit(toolId: string, tool: string, input: unknown, d: PolicyDecision, actor?: Actor): void {
    // A refusal is visible as a request that resolves at once, so the Inspector shows who refused and why.
    const reqId = `perm-${toolId}`;
    this.o.denied.add(toolId);
    this.o.sink.emit({ kind: 'permission.request', reqId, toolId, intent: intentFor(tool, input, undefined, actor), options: ['deny'] });
    this.o.sink.emit({ kind: 'permission.resolved', reqId, outcome: 'deny', by: d.by });
  }

  readonly preToolUse: HookCallback = async (input, toolUseID) => {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
    const toolId = input.tool_use_id ?? toolUseID ?? randomUUID();
    const actor = this.actorFor(input.agent_id, input.agent_type, toolId);
    // The hook input names the CLI's own mode. A mode this IDE never asks for means the CLI left what the host set: refuse (6.3 item 4).
    // Other values are not compared: the transient values around a live switch are legal.
    const cliMode = String((input as { permission_mode?: unknown }).permission_mode ?? '');
    if (DRIFT_MODES.has(cliMode)) {
      const drift: PolicyDecision = { decision: 'deny', by: 'failClosed', reason: 'the CLI is in a permission mode the IDE did not request', rule: 'policy.cli-mode-drift' };
      if (!this.driftTold) {
        this.driftTold = true;
        this.o.sink.emit({ kind: 'error', class: 'policy', message: `The Claude CLI reports the permission mode "${cliMode}", which this IDE never asks for; its tool calls are refused.`, retryable: false });
      }
      this.audit(toolId, input.tool_name, input.tool_input, drift, actor);
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: this.denyText(drift) } };
    }
    const d = await this.decide(toolId, input.tool_name, input.tool_input, actor);
    if (d.decision === 'deny') {
      this.audit(toolId, input.tool_name, input.tool_input, d, actor);
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: this.denyText(d, input.tool_name, input.tool_input) } };
    }
    // The call is going to start a sub-agent (after the card, for an ask): it stays open until its result reaches the lead.
    if (this.o.delegating && SPAWN_TOOLS.has(input.tool_name) && !actor) this.agentCalls.add(toolId);
    // `ask` forces the prompt even where the CLI would not ask; `allow` leaves the CLI's own rules (incl. our deny rules) in charge:
    // NEVER `permissionDecision: allow`, which would override the CLI workspace boundary and the whole of plan mode (spike Q2, Q5).
    if (d.decision === 'ask') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } };
    // An allowed Agent call: neutralise the levers the broker does not need to refuse (omitted run_in_background defaults to background).
    // A run without delegates gets the foreground rewrite alone: the CLI's own sub-agents (Explore, Plan) must not outlive the lead's turn.
    if (SPAWN_TOOLS.has(input.tool_name)) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: this.o.delegating ? rewriteAgentInput(input.tool_input) : foregroundAgentInput(input.tool_input) } };
    }
    return { continue: true };
  };

  readonly canUseTool: CanUseTool = async (toolName, input, o) => {
    const toolId = o.toolUseID;
    if (toolName === 'AskUserQuestion') return this.askQuestion(toolId, input, o.signal);
    const actor = this.actorFor(o.agentID, o.agentID ? this.agentTypes.get(o.agentID) : undefined, toolId);
    const d = await this.decide(toolId, toolName, input, actor);
    if (d.decision === 'deny') {
      this.audit(toolId, toolName, input, d, actor);
      return { behavior: 'deny', message: this.denyText(d, toolName, input) };
    }
    const forward = SPAWN_TOOLS.has(toolName) ? (this.o.delegating ? rewriteAgentInput(input) : foregroundAgentInput(input)) : input;
    if (d.decision === 'allow') {
      const refusal = this.refuseCliPrompt(toolId, toolName, input, o, actor);
      if (refusal) return refusal;
      return { behavior: 'allow', updatedInput: forward };
    }
    if (toolName === 'ExitPlanMode' && !actor) return this.planApproval(toolId, input, o.signal);
    const reqId = `perm-${toolId}`;
    const a = await this.requestAnswer(reqId, toolId, o.signal, () =>
      this.o.sink.emit({ kind: 'permission.request', reqId, toolId, intent: intentFor(toolName, input, undefined, actor), options: offeredOptions(d), ...(d.sessionAllow ? { sessionAllow: d.sessionAllow } : {}) }));
    this.o.sink.emit({ kind: 'permission.resolved', reqId, outcome: a.outcome, by: 'user' });
    if (a.outcome === 'allow') return { behavior: 'allow', updatedInput: forward };
    this.o.denied.add(toolId);
    return { behavior: 'deny', message: a.message ?? (a.outcome === 'cancelled' ? 'cancelled' : 'The user declined this action.') };
  };

  /**
   * In an unattended run `canUseTool` is reached only for a prompt the CLI raised ITSELF (Rust allowed, the hook let the call through).
   * Answer it from the cached Rust allow only when its reason was measured as benign (6.3 item 9); deny the rest with a message that
   * names the reason, and say so once per session and reason. Ask, Edit and Plan are untouched: a person answers there.
   */
  private refuseCliPrompt(toolId: string, toolName: string, input: Record<string, unknown>, o: Parameters<CanUseTool>[2], actor?: Actor): { behavior: 'deny'; message: string } | null {
    const mode = this.o.mode();
    if (!isUnattended(mode)) return null;
    const verdict = judgeCliPrompt({ mode, reason: o.decisionReason, blockedPath: o.blockedPath, intentPaths: this.decisions.get(toolId)?.intent.paths ?? undefined, cwd: this.o.cwd, runDirs: this.o.runDirs, command: toolName === 'Bash' && typeof input.command === 'string' ? input.command : undefined });
    if (!verdict) return null;
    const message = cliPromptMessage(verdict.reason, mode);
    if (!this.cliPromptTold.has(verdict.reason)) {
      this.cliPromptTold.add(verdict.reason);
      this.o.sink.emit({ kind: 'error', class: 'policy', message, retryable: false });
    }
    const refused: PolicyDecision = { decision: 'deny', by: 'hardStop', reason: message, rule: 'cli.prompt-denied' };
    this.audit(toolId, toolName, input, refused, actor);
    return { behavior: 'deny', message: this.denyText(refused) };
  }

  /**
   * The lead's ExitPlanMode in a Plan run: an approval card with the FULL plan (redacted, 64 KiB) and the working modes to continue
   * in (D2, 4.10). Approving switches the run mode: the session's view first, then the CLI through `updatedPermissions setMode`, which
   * is mandatory (without it the CLI restores the mode it had before the plan, spike Q4). Rejecting keeps Plan; the user's text goes
   * back to the model verbatim.
   */
  private async planApproval(toolId: string, input: Record<string, unknown>, signal: AbortSignal) {
    const raw = typeof input.plan === 'string' && input.plan ? input.plan : this.o.lastText?.() ?? '';
    const reqId = `perm-${toolId}`;
    const a = await this.requestAnswer(reqId, toolId, signal, () => this.o.sink.emit({
      kind: 'permission.request', reqId, toolId, intent: intentFor('ExitPlanMode', {}), options: ['allow_once', 'deny'], ...planPayload(raw),
    }));
    this.o.sink.emit({ kind: 'permission.resolved', reqId, outcome: a.outcome, by: 'user' });
    if (a.outcome === 'allow') {
      // the host always sends a validated mode; anything else (a bug) falls to the strictest working mode
      const mode = a.mode && PLAN_MODES.includes(a.mode) ? a.mode : 'ask';
      this.o.noteMode?.(mode);
      this.o.sink.emit({ kind: 'session.info', effective: { permission: mode, reason: 'planApproved' } });
      return { behavior: 'allow' as const, updatedInput: input, updatedPermissions: [{ type: 'setMode' as const, mode: permissionModeFor(mode), destination: 'session' as const }] };
    }
    this.o.denied.add(toolId);
    return { behavior: 'deny' as const, message: a.message ?? (a.outcome === 'cancelled' ? 'cancelled' : PLAN_REJECT_DEFAULT) };
  }

  /**
   * AskUserQuestion: every question is put to the user in turn (the CLI allows several in one call) and the answers are merged into one
   * `answers` object keyed by the question text, as the tool expects. A single question keeps the plain `q-<toolId>` request id.
   */
  private async askQuestion(toolId: string, input: Record<string, unknown>, signal: AbortSignal) {
    const qs = (Array.isArray(input.questions) ? (input.questions as Raw[]) : []).filter((q) => q && typeof q === 'object');
    const asked: Raw[] = qs.length ? qs : [{}];
    const answers: Record<string, string> = {};
    for (const [i, q] of asked.entries()) {
      const reqId = asked.length > 1 ? `q-${toolId}-${i}` : `q-${toolId}`;
      const a = await this.requestAnswer(reqId, toolId, signal, () => this.o.sink.emit({
        kind: 'question.request', reqId, toolId,
        prompt: String(q.question ?? ''),
        options: (Array.isArray(q.options) ? q.options : []).map((o: Raw) => ({ label: String(o.label), ...(o.description ? { description: String(o.description) } : {}) })),
      }));
      if (a.outcome !== 'allow') return { behavior: 'deny' as const, message: a.message ?? 'The user did not answer.' };
      Object.assign(answers, a.answers ?? {});
    }
    return { behavior: 'allow' as const, updatedInput: { ...input, answers } };
  }

  private requestAnswer(reqId: string, toolId: string, signal: AbortSignal, announce: () => void): Promise<PermissionAnswer> {
    return new Promise((resolve) => {
      const done = (a: PermissionAnswer) => { if (this.pending.delete(reqId)) resolve(a); };
      this.pending.set(reqId, { toolId, resolve: done });
      signal.addEventListener('abort', () => done({ outcome: 'cancelled' }), { once: true });
      announce();
    });
  }

  cancelPending(outcome: 'cancelled'): void {
    for (const [reqId, p] of [...this.pending]) {
      p.resolve({ outcome });
      if (reqId.startsWith('perm-')) this.o.sink.emit({ kind: 'permission.resolved', reqId, outcome, by: 'user' });
    }
  }

  answer(reqId: string, answer: PermissionAnswer): void { this.pending.get(reqId)?.resolve(answer); }
}
