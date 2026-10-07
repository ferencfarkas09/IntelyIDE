// One Codex session = one `codex app-server` child (stdio JSONL JSON-RPC) with one thread.
// Enforcement order (providers-plan 3.3 A5): explicit permission profile + approval policy on every thread/turn (never the
// bypass flags, never danger-full-access) -> every server approval request through policy/decide (ApprovalGate) -> a decline
// unless the broker allowed it once. Events are normalized by mapNotification(); this file only does I/O and lifecycle.
import { existsSync } from 'node:fs';
import { effortOf } from '../../abstract.js';
import { redact } from '../../redact.js';
import type { AgentSession, AuthFact, EventSink, ModelInfo, HostServices, PermissionAnswer, PolicyClient, PromptAttachment, SessionSpec, UserInput } from '../../types.js';
import { capsFor, modelsOf } from './caps.js';
import { assertSafeParams, buildCodexEnv, clampEffort, codexBinOf, policyFor, spawnArgs, type CodexPolicy } from './config.js';
import { ApprovalGate } from './gate.js';
import { mapNotification, newMapState, type MapState } from './map.js';
import { cliVersion, knownFeatures, type Server, startServer, stderrTail } from './proc.js';
import { cmpVersion, isObj, type Json, MIN_VERSION, parseVersion, str } from './wire.js';

const INIT_TIMEOUT_MS = 30_000;

/** Test seams: a different binary (the fake app-server), extra env for it, a longer or shorter request timeout. */
export interface OpenOptions { bin?: string; argsPrefix?: string[]; extraEnv?: Record<string, string>; allowWriter?: boolean; requestTimeoutMs?: number }

/**
 * The "other providers run readOnly roles only until proven" rule (3.1). The Rust host sets `acp.writeAllowed` when the computed
 * chip reaches the write tier or the user turned on "allow weak writer" for this provider (Settings > Safety); the env switch is dev/test only.
 */
function writerAllowed(spec: SessionSpec, o: OpenOptions): boolean {
  if (o.allowWriter !== undefined) return o.allowWriter;
  if (spec.acp?.writeAllowed === true) return true;
  return (spec.env.vars?.INTELY_CODEX_ALLOW_WRITE ?? process.env.INTELY_CODEX_ALLOW_WRITE) === '1';
}

export class CodexSession implements AgentSession {
  nativeId = '';
  private server!: Server;
  private threadId = '';
  private turnId?: string;
  private turnWaiters: ((id: string | undefined) => void)[] = [];
  private gate!: ApprovalGate;
  private state!: MapState;
  private pol!: CodexPolicy;
  private model = '';
  private effort: string | null = null;
  private closed = false;
  private assertions: string[] = [];
  /** Test tap: every notification before mapping. */
  onRaw?: (method: string, params: Json) => void;

  private constructor(private spec: SessionSpec, private sink: EventSink, private policy: PolicyClient, private host: HostServices, private opts: OpenOptions) {}

  static async open(spec: SessionSpec, sink: EventSink, policy: PolicyClient, host: HostServices, opts: OpenOptions = {}): Promise<CodexSession> {
    const pol = policyFor(spec.role.permission); // refuses `auto` before anything is spawned
    if (pol.mode !== 'readOnly') {
      if (!writerAllowed(spec, opts)) throw new Error('Codex runs read-only roles only until its enforcement suites passed (providers-plan 3.1); this role can edit');
      if ((spec.env.vars?.INTELY_READONLY ?? process.env.INTELY_READONLY) === '1') throw new Error('INTELY_READONLY is set: no writing role may start');
      if (!spec.env.shimDir) throw new Error('session/start env.shimDir is required for a writing session (the git shim is not optional)');
    }
    if (spec.auth.mode !== 'subscription') throw new Error(`Codex auth mode "${spec.auth.mode}" is not supported yet: the app-server ignores CODEX_API_KEY/OPENAI_API_KEY and needs an isolated CODEX_HOME + account/login/start (spike result)`);
    const s = new CodexSession(spec, sink, policy, host, opts);
    s.pol = pol;
    await s.start();
    return s;
  }

  // ---------- startup ----------
  private async start(): Promise<void> {
    const { spec, opts } = this;
    const built = buildCodexEnv(spec.env, spec.auth);
    const env = { ...built.env, ...(opts.extraEnv ?? {}) };
    const bin = opts.bin ?? codexBinOf(spec.env, existsSync);
    if (!bin) throw new Error('codex CLI not found on PATH (set env.codexBin)');
    const feats = await knownFeatures(bin, env);
    if (!feats) this.assertions.push('features: `codex features list` failed, so plugin/browser/hook features were not disabled');
    this.model = spec.role.model;
    this.state = newMapState({ cwd: spec.cwd, model: spec.role.model, costBasis: 'included' });
    this.gate = new ApprovalGate({ agentId: spec.agentId, provider: spec.provider, policy: this.policy, sink: this.sink, state: this.state, cwd: spec.cwd });
    const server = startServer(
      bin, [...(opts.argsPrefix ?? []), ...spawnArgs(feats ?? new Set())], env, spec.cwd,
      { onNotification: (m, p) => this.onNotification(m, p), onRequest: (m, p) => this.gate.handle(m, p) },
      (pid) => this.host.registerPid(pid),
    );
    this.server = server;
    void server.exited.then((x) => this.onExit(x));
    const t = opts.requestTimeoutMs;
    const call = <T = any>(method: string, params: Json = {}, ms = t ?? INIT_TIMEOUT_MS) => server.rpc.request<T>(method, params, ms);
    try {
      const init = await call('initialize', { clientInfo: { name: 'intely-ide', title: 'IntelyIDE', version: '0.0.0' }, capabilities: { experimentalApi: true } });
      const version = parseVersion(String(init?.userAgent ?? '')) ?? (await cliVersion(bin, env));
      if (version && cmpVersion(version, MIN_VERSION) < 0) throw new Error(`codex ${version} is older than the supported ${MIN_VERSION}`);
      server.rpc.notify('initialized');
      const auth = await this.checkAuth(call, built.strayKeys);
      const models = await this.loadModels(call);
      const entry = models.find((m) => m.id === spec.role.model);
      if (models.length && !entry) this.assertions.push(`model: role asks "${spec.role.model}", which Codex does not offer`);
      const eff = clampEffort(spec.role.effort, entry?.effortLevels ?? []);
      this.effort = eff.level;
      if (spec.role.effort && eff.clamped) this.assertions.push(`effort: role asks "${spec.role.effort}", applied ${eff.level ? `"${eff.level}"` : 'none (model has no effort control)'}`);
      await this.openThread(call);
      this.sink.emit({ kind: 'session.info', nativeId: this.nativeId, models, caps: capsFor(entry) });
      this.sink.emit({
        kind: 'session.started', nativeId: this.nativeId, model: this.model,
        effective: { effort: effortOf(this.effort), permission: this.pol.mode, sandbox: this.pol.sandboxLabel },
        auth, assertions: this.assertions,
      });
    } catch (e) {
      const detail = stderrTail(server.stderr);
      await this.close();
      throw new Error(`codex app-server did not start: ${redact((e as Error).message)}${detail ? ` | ${detail}` : ''}`);
    }
  }

  private async checkAuth(call: (m: string, p?: Json) => Promise<any>, strayKeys: string[]): Promise<AuthFact> {
    const acc = await call('account/read', { refreshToken: false });
    const a = isObj(acc?.account) ? acc.account : undefined;
    if (!a) throw new Error('codex is not logged in (run `codex login` in a terminal); the IDE never starts a login');
    const source = a.type === 'chatgpt' ? 'chatgpt' : String(a.type ?? 'unknown');
    let warning: string | undefined;
    if (a.type !== 'chatgpt') warning = `subscription session is using credential "${source}" (API billing); expected the ChatGPT login`;
    else if (strayKeys.length) warning = `${strayKeys.join(', ')} was set in the host environment and was removed for this subscription session`;
    return { mode: this.spec.auth.mode, source, ...(warning ? { warning } : {}) };
  }

  private async loadModels(call: (m: string, p?: Json) => Promise<any>): Promise<ModelInfo[]> {
    try {
      const r = await call('model/list', { limit: 100 });
      return modelsOf(r);
    } catch { this.assertions.push('model/list failed: model and effort were not checked'); return []; }
  }

  /** Safe defaults on both sides: our explicit parameters AND a check that Codex applied exactly those. */
  private async openThread(call: (m: string, p?: Json) => Promise<any>): Promise<void> {
    const { spec, pol } = this;
    const params: Json = {
      cwd: spec.cwd, model: spec.role.model, approvalPolicy: pol.approval, permissions: pol.profile,
      ...(spec.role.systemPrompt ? { developerInstructions: spec.role.systemPrompt } : {}),
    };
    assertSafeParams(params);
    const r = spec.resume ? await call('thread/resume', { ...params, threadId: spec.resume.nativeId }) : await call('thread/start', { ...params, ephemeral: false, serviceName: 'intely-ide' });
    const id = str(r?.thread?.id);
    if (!id) throw new Error('thread/start returned no thread id (schema drift)');
    // fail closed: Codex must report the profile and approval policy we asked for, and never a full-access sandbox
    const profile = str(r?.activePermissionProfile?.id);
    const sandboxType = str(r?.sandbox?.type);
    if (profile !== pol.profile) throw new Error(`Codex applied permission profile "${profile ?? 'none'}", expected "${pol.profile}"`);
    if (sandboxType === 'dangerFullAccess' || sandboxType === 'externalSandbox') throw new Error(`Codex runs with sandbox "${sandboxType}"`);
    if (r?.approvalPolicy !== pol.approval) throw new Error(`Codex applied approval policy ${JSON.stringify(r?.approvalPolicy)}, expected "${pol.approval}"`);
    if (pol.mode !== 'readOnly' && r?.sandbox?.networkAccess === true) throw new Error('Codex sandbox has network access enabled');
    if (typeof r?.model === 'string' && r.model !== spec.role.model) this.assertions.push(`model: role asks "${spec.role.model}", Codex runs "${r.model}"`);
    if (typeof r?.model === 'string') this.model = r.model;
    this.state.model = this.model;
    this.threadId = id;
    this.nativeId = id;
    if (spec.addDirs.length) this.assertions.push(`addDirs: ${spec.addDirs.length} directory(ies) are readable but not writable (Codex reads the whole disk inside the sandbox; the never-read list is not enforced)`);
    if (existsSync(`${spec.env.vars?.HOME ?? process.env.HOME ?? ''}/.codex/rules`)) this.assertions.push('user rules: ~/.codex/rules may auto-approve commands outside the broker (app-server has no --ignore-rules)');
  }

  // ---------- notifications ----------
  private onNotification(method: string, p: Json): void {
    this.onRaw?.(method, p);
    if (p.threadId && this.threadId && p.threadId !== this.threadId) return; // another thread (sub-agent): not ours to show
    if (method === 'turn/started') {
      const id = str(p.turn?.id);
      if (id) { this.turnId = id; this.turnWaiters.splice(0).forEach((w) => w(id)); }
    }
    for (const e of mapNotification(this.state, method, p)) this.sink.emit(e);
    if (method === 'turn/completed') {
      this.turnId = undefined;
      this.gate.cancelAll();
    }
  }

  private onExit(x: { code: number | null; signal: NodeJS.Signals | null }): void {
    this.turnWaiters.splice(0).forEach((w) => w(undefined));
    if (this.closed) return;
    const tail = stderrTail(this.server.stderr);
    this.sink.emit({ kind: 'error', class: 'provider', message: redact(`codex app-server exited (${x.signal ?? x.code})${tail ? `: ${tail}` : ''}`), retryable: false });
    this.gate.cancelAll();
    this.sink.emit({ kind: 'turn.end', stopReason: 'error' });
  }

  // ---------- AgentSession ----------
  prompt(input: UserInput): void {
    void this.startTurn(input);
  }

  private async startTurn(input: UserInput): Promise<void> {
    const params: Json = {
      threadId: this.threadId, input: toInput(input), cwd: this.spec.cwd, model: this.spec.role.model,
      ...(this.effort ? { effort: this.effort } : {}), summary: 'concise',
      approvalPolicy: this.pol.approval, permissions: this.pol.profile,
    };
    try {
      assertSafeParams(params);
      const r = await this.server.rpc.request('turn/start', params, this.opts.requestTimeoutMs ?? 30_000);
      const id = str(r?.turn?.id);
      if (id && !this.turnId) { this.turnId = id; this.turnWaiters.splice(0).forEach((w) => w(id)); }
    } catch (e) {
      if (this.closed) return;
      this.sink.emit({ kind: 'error', class: /unauthor|401|login/i.test((e as Error).message) ? 'auth' : 'provider', message: redact((e as Error).message), retryable: false });
      this.sink.emit({ kind: 'turn.end', stopReason: 'error' });
    }
  }

  async interrupt(): Promise<void> {
    this.gate.cancelAll(); // pending approvals are answered "cancel" and resolve cancelled
    const turnId = this.turnId ?? (await Promise.race([new Promise<string | undefined>((r) => this.turnWaiters.push(r)), new Promise<undefined>((r) => setTimeout(r, 1500))]));
    if (!turnId || this.server.rpc.closed) return;
    await this.server.rpc.request('turn/interrupt', { threadId: this.threadId, turnId }, 3000).catch(() => undefined);
  }

  async setModel(id: string): Promise<void> {
    this.spec.role.model = id; // sent explicitly with the next turn
    this.model = id;
    this.state.model = id;
    this.sink.emit({ kind: 'session.info', nativeId: this.nativeId, effective: { model: id } });
  }

  async setEffort(level: string): Promise<void> {
    this.effort = level;
    this.sink.emit({ kind: 'session.info', nativeId: this.nativeId, effective: { effort: effortOf(level) } });
  }

  answer(reqId: string, answer: PermissionAnswer): void { this.gate.answer(reqId, answer); }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.gate.cancelAll();
    this.turnWaiters.splice(0).forEach((w) => w(undefined));
    this.server.rpc.close();
    await this.server.stop();
  }
}

function toInput(input: UserInput): Json[] {
  const items: Json[] = [];
  const files: PromptAttachment[] = [];
  for (const a of input.attachments ?? []) {
    if (a.kind === 'image') items.push({ type: 'localImage', path: a.path });
    else files.push(a);
  }
  const note = files.length ? `\n\nAttached files (read-only context):\n${files.map((f) => `- ${f.name}: ${f.path}`).join('\n')}` : '';
  return [{ type: 'text', text: `${input.text}${note}` }, ...items];
}
