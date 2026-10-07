// Approval broker for Codex server requests (providers-plan 1.6, 3.3 A5). Every request that could run a command, change
// a file, widen a permission or reach the network is judged by policy/decide FIRST; anything but a clean reply is a decline.
// The answer is always the plain one-shot decision: `acceptForSession`, `acceptWithExecpolicyAmendment`,
// `applyNetworkPolicyAmendment`, `approved_for_session` and permission grants are never sent, whatever the server offers.
import type { EventSink, PermissionAnswer, PolicyClient, PolicyDecision, ProviderId, ToolIntent } from '../../types.js';
import { abs, argvIntent, commandIntent, fileIntent, networkIntent, otherIntent } from './intent.js';
import type { MapState } from './map.js';
import { RpcRemoteError } from './rpc.js';
import { isObj, type Json, REQ, str } from './wire.js';

type Pending = { toolId: string; resolve(a: PermissionAnswer): void };

export class ApprovalGate {
  private pending = new Map<string, Pending>();
  private seq = 0;
  /** Decisions sent back to the server (for tests and the Inspector): kind -> answer. */
  readonly sent: { method: string; answer: string }[] = [];

  constructor(private o: { agentId: string; provider: ProviderId; policy: PolicyClient; sink: EventSink; state: MapState; cwd: string }) {}

  get pendingCount(): number { return this.pending.size; }

  /** RpcPeer.onRequest. Unknown methods throw so the peer answers "method not found". */
  async handle(method: string, p: Json): Promise<unknown> {
    switch (method) {
      case REQ.command: return this.command(p);
      case REQ.fileChange: return this.fileChange(p);
      case REQ.legacyExec: return this.legacyExec(p);
      case REQ.legacyPatch: return this.legacyPatch(p);
      case REQ.permissions: return this.permissions(p);
      case REQ.userInput: return this.userInput(p);
      case REQ.elicitation: return { action: 'decline' };
      case REQ.dynamicTool: return { success: false, contentItems: [{ type: 'inputText', text: 'No dynamic tools are registered by this client.' }] };
      default: throw new RpcRemoteError(-32601, `method not found: ${method}`);
    }
  }

  // ---------- decision plumbing ----------
  private async decide(toolId: string, intent: ToolIntent): Promise<PolicyDecision> {
    let d: PolicyDecision;
    try {
      d = await this.o.policy.decide({ agentId: this.o.agentId, toolId, provider: this.o.provider, intent });
      if (!d || !['allow', 'deny', 'ask'].includes(d.decision)) d = { decision: 'deny', by: 'failClosed', reason: 'malformed policy decision' };
    } catch (e) {
      d = { decision: 'deny', by: 'failClosed', reason: `policy unavailable: ${(e as Error).message}` };
    }
    return d;
  }

  private refuse(toolId: string, intent: ToolIntent, by: PolicyDecision['by']): void {
    // A refusal is visible as a request that resolves at once, so the Inspector shows who refused.
    const reqId = `perm-${toolId}-${++this.seq}`;
    this.o.state.denied.add(toolId);
    this.o.sink.emit({ kind: 'permission.request', reqId, toolId, intent, options: ['deny'] });
    this.o.sink.emit({ kind: 'permission.resolved', reqId, outcome: 'deny', by });
  }

  private ask(reqId: string, toolId: string): Promise<PermissionAnswer> {
    return new Promise((resolve) => { this.pending.set(reqId, { toolId, resolve: (a) => { if (this.pending.delete(reqId)) resolve(a); } }); });
  }

  /** policy -> (user) -> 'allow' | 'deny' | 'cancel'. `canAllow` false means the server offers no plain one-shot accept. */
  private async judge(toolId: string, intent: ToolIntent, canAllow: boolean): Promise<'allow' | 'deny' | 'cancel'> {
    const d = await this.decide(toolId, intent);
    if (d.decision === 'deny') { this.refuse(toolId, intent, d.by); return 'deny'; }
    if (!canAllow) { this.refuse(toolId, intent, 'default'); return 'deny'; }
    if (d.decision === 'allow') return 'allow';
    const reqId = `perm-${toolId}-${++this.seq}`;
    const waiting = this.ask(reqId, toolId);
    this.o.sink.emit({ kind: 'permission.request', reqId, toolId, intent, options: ['allow_once', 'deny'] });
    const a = await waiting;
    this.o.sink.emit({ kind: 'permission.resolved', reqId, outcome: a.outcome, by: 'user' });
    if (a.outcome === 'allow') return 'allow';
    if (a.outcome === 'cancelled') return 'cancel';
    this.o.state.denied.add(toolId);
    return 'deny';
  }

  private reply<T extends string>(method: string, v: T): T { this.sent.push({ method, answer: v }); return v; }

  /** `availableDecisions` absent means the default set (plain accept included). */
  private canAccept(p: Json, plain: string): boolean {
    const list = p.availableDecisions;
    return !Array.isArray(list) || list.includes(plain);
  }

  // ---------- requests ----------
  private async command(p: Json): Promise<unknown> {
    const toolId = str(p.itemId) ?? `cmd-${++this.seq}`;
    const decision = (v: 'accept' | 'decline' | 'cancel') => ({ decision: this.reply(REQ.command, v) });
    const ctx = isObj(p.networkApprovalContext) ? p.networkApprovalContext : undefined;
    const command = str(p.command);
    let intent: ToolIntent;
    if (ctx && str(ctx.host)) intent = networkIntent(String(ctx.host), String(ctx.protocol ?? 'https'));
    else if (command) intent = commandIntent(command, str(p.reason));
    else { this.refuse(toolId, otherIntent('shell', 'command approval without a command'), 'failClosed'); return decision('decline'); }
    // additional permissions (extra filesystem / network reach) are never granted through an approval
    if (isObj(p.additionalPermissions) && (p.additionalPermissions.fileSystem || p.additionalPermissions.network)) {
      this.refuse(toolId, { ...intent, summary: `${intent.summary} [asks for extra permissions]` }, 'default');
      return decision('decline');
    }
    const r = await this.judge(toolId, intent, this.canAccept(p, 'accept'));
    return decision(r === 'allow' ? 'accept' : r === 'cancel' ? 'cancel' : 'decline');
  }

  private async fileChange(p: Json): Promise<unknown> {
    const toolId = str(p.itemId) ?? `file-${++this.seq}`;
    const decision = (v: 'accept' | 'decline' | 'cancel') => ({ decision: this.reply(REQ.fileChange, v) });
    const known = this.o.state.items.get(toolId)?.paths ?? [];
    const root = str(p.grantRoot);
    // an approval that grants write access to a whole root is a standing permission, not one edit: refused
    if (root) { this.refuse(toolId, fileIntent([abs(this.o.cwd, root)], 'asks to grant write access to a root'), 'default'); return decision('decline'); }
    if (!known.length) { this.refuse(toolId, otherIntent('apply_patch', 'file change approval for an unknown item'), 'failClosed'); return decision('decline'); }
    const r = await this.judge(toolId, fileIntent(known, str(p.reason)), this.canAccept(p, 'accept'));
    return decision(r === 'allow' ? 'accept' : r === 'cancel' ? 'cancel' : 'decline');
  }

  private async legacyExec(p: Json): Promise<unknown> {
    const toolId = str(p.callId) ?? `cmd-${++this.seq}`;
    const decision = (v: 'approved' | 'denied' | 'abort') => ({ decision: this.reply(REQ.legacyExec, v) });
    const argv = Array.isArray(p.command) ? p.command.filter((a: unknown): a is string => typeof a === 'string') : [];
    if (!argv.length) { this.refuse(toolId, otherIntent('shell', 'exec approval without a command'), 'failClosed'); return decision('denied'); }
    const r = await this.judge(toolId, argvIntent(argv, str(p.reason)), true);
    return decision(r === 'allow' ? 'approved' : r === 'cancel' ? 'abort' : 'denied');
  }

  private async legacyPatch(p: Json): Promise<unknown> {
    const toolId = str(p.callId) ?? `file-${++this.seq}`;
    const decision = (v: 'approved' | 'denied' | 'abort') => ({ decision: this.reply(REQ.legacyPatch, v) });
    const paths = isObj(p.fileChanges) ? Object.keys(p.fileChanges).map((f) => abs(this.o.cwd, f)) : [];
    if (str(p.grantRoot) || !paths.length) { this.refuse(toolId, fileIntent(paths, 'unverifiable patch approval'), 'failClosed'); return decision('denied'); }
    const r = await this.judge(toolId, fileIntent(paths, str(p.reason)), true);
    return decision(r === 'allow' ? 'approved' : r === 'cancel' ? 'abort' : 'denied');
  }

  private async permissions(p: Json): Promise<unknown> {
    const toolId = str(p.itemId) ?? `perm-${++this.seq}`;
    this.refuse(toolId, otherIntent('request_permissions', `asks for extra permissions: ${JSON.stringify(p.permissions ?? {})}`), 'default');
    this.reply(REQ.permissions, 'none');
    return { permissions: {} };
  }

  private async userInput(p: Json): Promise<unknown> {
    const toolId = str(p.itemId) ?? `q-${++this.seq}`;
    const answers: Record<string, { answers: string[] }> = {};
    for (const q of Array.isArray(p.questions) ? p.questions.filter(isObj) : []) {
      const id = str(q.id);
      if (!id || q.isSecret === true) continue; // a secret is never typed into the IDE chat
      const reqId = `q-${toolId}-${++this.seq}`;
      const waiting = this.ask(reqId, toolId);
      this.o.sink.emit({
        kind: 'question.request', reqId, toolId, prompt: String(q.question ?? ''),
        options: (Array.isArray(q.options) ? q.options.filter(isObj) : []).map((o) => ({ label: String(o.label), ...(o.description ? { description: String(o.description) } : {}) })),
      });
      const a = await waiting;
      if (a.outcome !== 'allow') break;
      const label = a.answers?.[String(q.question ?? '')] ?? Object.values(a.answers ?? {})[0];
      if (label) answers[id] = { answers: [label] };
    }
    this.reply(REQ.userInput, Object.keys(answers).length ? 'answered' : 'none');
    return { answers };
  }

  // ---------- from the UI / the session ----------
  answer(reqId: string, a: PermissionAnswer): void { this.pending.get(reqId)?.resolve(a); }

  /** Turn interrupted or session closed: every open approval resolves "cancelled" (the server then gets `cancel`). */
  cancelAll(): void {
    for (const p of [...this.pending.values()]) p.resolve({ outcome: 'cancelled' });
  }
}
