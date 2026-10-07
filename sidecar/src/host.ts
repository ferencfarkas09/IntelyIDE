// Session registry between the protocol and the adapters: lease per session, gap-free event stream through TurnGuard,
// cancel protocol (providers-plan 5.6), orphan protection. Everything Rust-facing goes through ProtocolClient.
import { execFile } from 'node:child_process';
import { isWriterMode, UnsupportedModeError } from './abstract.js';
import { ProviderDisabledError, type Loader } from './loader.js';
import { redact } from './redact.js';
import { SdkError, sdkSetupHint } from './sdk.js';
import type { ProtocolClient } from './protocol.js';
import { SeqSink, TurnGuard } from './turn.js';
import type { AgentSession, HostServices, McpSet, ProviderId, SessionSpec, SidecarMsg } from './types.js';

const LEASE_TTL_MS = 15_000;

interface Entry {
  agentId: string;
  provider: ProviderId;
  session: AgentSession;
  guard: TurnGuard;
  leaseId?: string;
  pgids: Set<number>;
  prompts: number;
}

export class SidecarHost {
  private sessions = new Map<string, Entry>();

  constructor(private proto: ProtocolClient, private loader: Loader) {
    proto.on('session/start', (b) => this.start(b));
    proto.on('session/prompt', (b) => this.prompt(b));
    proto.on('cancel/request', (b) => this.cancel(b));
    proto.on('permission/answer', (b) => this.answer(b));
    proto.on('session/permission', (b) => this.permission(b));
    proto.on('session/mcp-status', (b) => this.mcpStatus(b));
    proto.on('session/close', (b) => this.close(b.agentId));
  }

  get count(): number { return this.sessions.size; }

  private async start(b: SidecarMsg['session/start']['body']): Promise<SidecarMsg['session/start']['reply']> {
    if (this.sessions.has(b.agentId)) return { error: 'duplicate', detail: b.agentId };
    let provider;
    try { provider = await this.loader.load(b.provider); } catch (e) {
      return { error: e instanceof ProviderDisabledError ? 'providerDisabled' : 'loadFailed', detail: (e as Error).message };
    }
    let leaseId: string | undefined;
    try {
      const lease = await this.proto.request('slot/acquire', { agentId: b.agentId, provider: b.provider, writer: b.writer ?? isWriterMode(b.role.permission), ...(b.repoId ? { repoId: b.repoId } : {}), ttlMs: LEASE_TTL_MS });
      if ('error' in lease) return { error: lease.error, ...(lease.detail ? { detail: lease.detail } : {}) };
      leaseId = lease.leaseId;
    } catch (e) {
      return { error: 'noSlot', detail: (e as Error).message };
    }
    const seq = new SeqSink((ev) => this.proto.emit(b.agentId, b.provider, ev), b.nextSeq ?? 1);
    const guard = new TurnGuard(seq, b.nextSeq && b.nextSeq > 1 ? `turn-s${b.nextSeq}-` : 'turn-');
    const entry: Entry = { agentId: b.agentId, provider: b.provider, session: undefined as never, guard, leaseId, pgids: new Set(), prompts: b.nextSeq ?? 0 };
    const services: HostServices = { registerPid: (pid) => this.registerPid(entry, pid) };
    const spec: SessionSpec = {
      agentId: b.agentId, provider: b.provider, role: b.role, cwd: b.cwd, addDirs: b.addDirs ?? [], env: b.env, mcp: (b.mcp ?? {}) as McpSet, auth: b.auth,
      ...(b.resume ? { resume: b.resume } : {}), ...(b.sessionId ? { sessionId: b.sessionId } : {}), ...(b.mock ? { mock: b.mock } : {}), ...(b.acp ? { acp: b.acp } : {}),
      ...(b.settingSources ? { settingSources: b.settingSources } : {}), ...(typeof b.denyRules === 'boolean' ? { denyRules: b.denyRules } : {}),
      ...(b.delegates?.length ? { delegates: b.delegates } : {}), ...(b.planDir ? { planDir: b.planDir } : {}),
    };
    try {
      entry.session = await provider.open(spec, guard, this.proto, services);
    } catch (e) {
      // A missing or unverified Agent SDK is not fixed by trying again: the message names the command that sets it up.
      const message = e instanceof SdkError ? `${e.message}. ${sdkSetupHint()}` : (e as Error).message;
      guard.beginTurn();
      guard.emit({ kind: 'error', class: 'provider', message, retryable: false });
      guard.endTurn('error');
      this.proto.flush(b.agentId);
      this.release(entry);
      return { error: 'open', detail: message };
    }
    this.sessions.set(b.agentId, entry);
    return { ok: true, nativeId: entry.session.nativeId };
  }

  private registerPid(e: Entry, pid: number): void {
    // The adapter spawns its CLI as a group leader, so pgid == pid; verify through ps and never register our own group.
    execFile('ps', ['-o', 'pgid=', '-p', String(pid)], (err, out) => {
      const pgid = err ? pid : Number(out.trim()) || pid;
      if (pgid === process.pid || !e.leaseId) return;
      e.pgids.add(pgid);
      this.proto.request('slot/renew', { leaseId: e.leaseId, pgids: [...e.pgids] }).catch(() => undefined);
    });
  }

  private prompt(b: SidecarMsg['session/prompt']['body']): SidecarMsg['session/prompt']['reply'] {
    const e = this.sessions.get(b.agentId);
    if (!e) return { error: 'noSession' };
    if (e.guard.turnOpen) return { error: 'turnOpen' };
    e.guard.beginTurn();
    // The log rebuilds the whole transcript, so it carries the attachment metadata (never the path or the contents).
    const refs = (b.attachments ?? []).map(({ id, name, mime, size, kind, sha256 }) => ({ id, name, mime, size, kind, sha256 }));
    e.guard.emit({ kind: 'user.message', messageId: `u-${++e.prompts}`, text: b.text, ...(refs.length ? { attachments: refs } : {}) });
    e.session.prompt({ text: b.text, ...(b.attachments?.length ? { attachments: b.attachments } : {}) });
    return { ok: true };
  }

  /** Acks at once, then interrupts and reports cancel/done; Rust escalates to SIGTERM/SIGKILL on its own clock. */
  private cancel(b: SidecarMsg['cancel/request']['body']): SidecarMsg['cancel/request']['reply'] {
    const e = this.sessions.get(b.agentId);
    if (e) void this.interrupt(e, b.softMs, b.termMs);
    else this.proto.notify('cancel/done', { agentId: b.agentId, stopReason: 'cancelled', ms: 0 });
    return { ok: true };
  }

  private async interrupt(e: Entry, softMs: number, termMs?: number): Promise<void> {
    const t0 = Date.now();
    const deadline = t0 + softMs;
    try { await Promise.race([e.session.interrupt({ softMs, termMs }), new Promise((r) => setTimeout(r, softMs))]); } catch { /* ends the turn below */ }
    while (e.guard.turnOpen && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    e.guard.endTurn('cancelled'); // synthesizes cancelled results; no-op when the adapter already ended the turn
    this.proto.flush(e.agentId);
    this.proto.notify('cancel/done', { agentId: e.agentId, stopReason: 'cancelled', ms: Date.now() - t0 });
  }

  private answer(b: SidecarMsg['permission/answer']['body']): SidecarMsg['permission/answer']['reply'] {
    const { agentId, reqId, ...a } = b;
    this.sessions.get(agentId)?.session.answer(reqId, a);
    return { ok: true };
  }

  /**
   * Live permission-mode switch (D8). Claude and the mock adapter implement it; a session without `setPermission`, or one that refuses the mode
   * as something its provider can never do, answers `unsupported`; the CLI refusing is `rejected`; no answer in 5 s is `timeout`.
   * Rust has already switched its own side: a failure here is reported, never papered over.
   */
  private async permission(b: SidecarMsg['session/permission']['body']): Promise<SidecarMsg['session/permission']['reply']> {
    const e = this.sessions.get(b.agentId);
    if (!e) return { error: 'noSession' };
    if (!e.session.setPermission) return { error: 'unsupported', detail: `${e.provider} has no live permission switch` };
    try {
      await e.session.setPermission(b.mode);
      return { ok: true };
    } catch (err) {
      const msg = redact(err instanceof Error ? err.message : String(err));
      if (err instanceof UnsupportedModeError) return { error: 'unsupported', detail: msg };
      return { error: msg.startsWith('timeout') ? 'timeout' : 'rejected', detail: msg };
    }
  }

  /** The live MCP servers of a session; `unsupported` for a provider without them, `failed` when the CLI did not answer. */
  private async mcpStatus(b: SidecarMsg['session/mcp-status']['body']): Promise<SidecarMsg['session/mcp-status']['reply']> {
    const e = this.sessions.get(b.agentId);
    if (!e) return { error: 'noSession' };
    if (!e.session.mcpStatus) return { error: 'unsupported', detail: `${e.provider} has no MCP status` };
    try {
      const servers = await e.session.mcpStatus({ ...(b.reconnect ? { reconnect: b.reconnect } : {}), ...(b.toggle ? { toggle: b.toggle } : {}) });
      return { ok: true, servers };
    } catch (err) {
      return { error: 'failed', detail: redact(err instanceof Error ? err.message : String(err)) };
    }
  }

  /** Fire and forget: on shutdown the pipe is already half closed and nobody would answer. */
  private release(e: Entry): void {
    if (!e.leaseId) return;
    this.proto.notify('slot/release', { leaseId: e.leaseId });
    e.leaseId = undefined;
  }

  async close(agentId: string): Promise<SidecarMsg['session/close']['reply']> {
    const e = this.sessions.get(agentId);
    if (!e) return { ok: true };
    this.sessions.delete(agentId);
    await e.session.close().catch(() => undefined);
    e.guard.endTurn('cancelled');
    this.proto.flush(agentId);
    this.release(e);
    return { ok: true };
  }

  /** Pipe closed or parent gone: no reply is possible, so just stop every child. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}
