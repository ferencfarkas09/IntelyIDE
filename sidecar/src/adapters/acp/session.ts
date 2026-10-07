// One ACP session = one long-lived agent child process (its own process group) driven through @agentclientprotocol/sdk (protocol v1).
// Enforcement order (providers-plan 3.1, 3.3): the agent's own session/request_permission -> policy/decide (hard stop beats everything,
// fail closed on a timeout or a malformed reply) -> only a one-time option is ever selected. The fs/* and terminal/* capabilities we
// advertise are OUR handlers (path jail, process group, scrubbed env with the git shim first), each one judged by policy/decide first.
// An agent that runs its own shell never reaches these handlers; that is why every ACP adapter starts at tier "weak".
import fs from 'node:fs';
import { Readable, Writable } from 'node:stream';
import {
  type Client,
  ClientSideConnection,
  type ContentBlock,
  type InitializeResponse,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { effortOf, UnsupportedModeError } from '../../abstract.js';
import { POLICY_TIMEOUT_MS } from '../../protocol.js';
import { redact, redactDeep, truncate } from '../../redact.js';
import type {
  AgentSession, HostServices, InterruptOpts, ModelInfo, PermissionAnswer, PermissionMode, PolicyClient, PolicyDecision,
  ProviderCaps, SessionSpec, StopReason, ToolIntent, UsageRecord, UserInput, EventSink,
} from '../../types.js';
import { fenced, MAX_INLINE_TEXT } from '../claude-sdk/attachments.js';
import { computeCaps, type ConfigView, configView, modelsOf } from './caps.js';
import { execIntent, intentFor } from './intent.js';
import { Jail, JailError } from './jail.js';
import { agentEnv, killTree, processTree, resolveCommand, type Spawned, spawnAgent } from './launch.js';
import { ensureTool, flushSegment, mapUpdate, type MapState, newMapState, redactKeys, resetTurn } from './map.js';
import { abstractMode, currentMode, isUnsafeMode, modeChoices, modeFor, pick, pickEffort } from './modes.js';
import type { AcpProfile } from './profiles.js';
import { TerminalError, Terminals } from './terminals.js';

type Raw = Record<string, any>;

const INIT_TIMEOUT_MS = 30_000;
const TERM_MS = 3000;
/** The adapter escalates a little before the host's own soft deadline so its turn.end(cancelled) is the one that counts. */
const DEFAULT_SOFT_MS = 5000;
const SOFT_MARGIN_MS = 400;
const STOP: Record<string, StopReason> = { end_turn: 'endTurn', max_tokens: 'maxTokens', max_turn_requests: 'maxTurns', refusal: 'refusal', cancelled: 'cancelled' };
const BLOCKED_CODE = -32003;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${what}`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

const zeroCounts = () => ({ inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 });
const addCounts = (a: ReturnType<typeof zeroCounts>, b: ReturnType<typeof zeroCounts>) => ({
  inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite, reasoningTokens: a.reasoningTokens + b.reasoningTokens,
});

export class AcpAuthError extends Error {}

interface Pending { toolId: string; resolve: (a: PermissionAnswer) => void }
type Gate = { ok: true } | { ok: false; reason: string; cancelled?: boolean };

export class AcpSession implements AgentSession {
  nativeId = '';
  setModel?: (id: string) => Promise<void>;
  setEffort?: (level: string) => Promise<void>;
  setPermission?: (mode: PermissionMode) => Promise<void>;

  private conn!: ClientSideConnection;
  private proc!: Spawned;
  private init!: InitializeResponse;
  private cfg: ConfigView = {};
  private jail: Jail;
  private terminals!: Terminals;
  private map: MapState = newMapState();
  private pending = new Map<string, Pending>();
  private reqN = 0;
  private cumulative = zeroCounts();
  private inflight?: Promise<void>;
  private turnActive = false;
  private cancelling = false;
  private abandoned = false;
  private loading = false;
  private dead = false;
  private closing = false;
  private model = '';
  private caps!: ProviderCaps;
  private assertions: string[] = [];
  private termMs: number;
  /** Methods the agent called that we do not implement (vendor extensions); answered with methodNotFound. */
  readonly unknownMethods: string[] = [];

  private constructor(private profile: AcpProfile, private spec: SessionSpec, private sink: EventSink, private policy: PolicyClient, private host: HostServices) {
    this.jail = new Jail(spec.cwd, spec.addDirs);
    this.termMs = spec.acp?.termMs ?? TERM_MS;
  }

  static async open(profile: AcpProfile, spec: SessionSpec, sink: EventSink, policy: PolicyClient, host: HostServices): Promise<AcpSession> {
    const mode = spec.role.permission;
    if (mode === 'automatic' || mode === 'bypass') throw new Error(`permission "${mode}" is not offered: ACP agents never run with an auto-approve mode`);
    // 3.1: providers other than Claude run readOnly roles only until their own attempt suites are green (Rust sets writeAllowed).
    if (mode !== 'readOnly' && !spec.acp?.writeAllowed) {
      throw new Error(`${profile.name} may only run read-only roles until its enforcement suites pass (role "${spec.role.name}" is "${mode}")`);
    }
    const s = new AcpSession(profile, spec, sink, policy, host);
    await s.start();
    return s;
  }

  // ---------- start ----------
  private async start(): Promise<void> {
    const { spec, profile } = this;
    const command = await resolveCommand(spec.acp?.command ?? profile.command);
    if (!command) throw new Error(`${profile.name} is not installed (looked for "${spec.acp?.command ?? profile.command}" on the login-shell PATH)`);
    const args = spec.acp?.args ?? profile.args(spec.role.permission);
    const { env } = agentEnv(spec.env, spec.auth, { keyVar: profile.keyEnv, extra: spec.acp?.env });
    this.proc = await spawnAgent(command, args, spec.cwd, env, (pid) => this.host.registerPid(pid));
    // a command the agent runs never needs (and could print) the agent's own credential variable
    const termEnv = { ...env };
    if (profile.keyEnv && !spec.acp?.env?.[profile.keyEnv]) delete termEnv[profile.keyEnv];
    this.terminals = new Terminals({ jail: this.jail, cwd: spec.cwd, baseEnv: termEnv, onPid: (pid) => this.host.registerPid(pid) });
    void this.proc.exited.then(({ code, signal }) => this.gone(`${profile.name} process ended (${signal ?? `exit code ${code}`})`));

    const stream = ndJsonStream(Writable.toWeb(this.proc.child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(this.proc.child.stdout!) as ReadableStream<Uint8Array>);
    this.conn = new ClientSideConnection(() => this.client(), stream);
    void this.conn.closed.then(() => this.gone(`${profile.name} closed the connection`));

    const limit = spec.acp?.initTimeoutMs ?? INIT_TIMEOUT_MS;
    try {
      this.init = await withTimeout(this.conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        // fs and terminal are ours, judged by the broker; terminal-auth is not offered (the IDE cannot run it, 4.2)
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true, auth: { terminal: false } },
        clientInfo: { name: 'IntelySwitchIDE', version: '0.1' },
      }), limit, 'initialize');
      if (this.init.protocolVersion !== PROTOCOL_VERSION) throw new Error(`${profile.name} speaks ACP v${this.init.protocolVersion}; this client speaks v${PROTOCOL_VERSION}`);
      await this.authenticateIfAsked(limit);
      await this.openSession(limit);
      await this.applyRole(limit);
    } catch (e) {
      const tail = redact(this.proc.stderrTail.text.trim()).slice(-400);
      await this.teardown();
      if (e instanceof AcpAuthError) throw e;
      throw new Error(`${profile.name} did not start: ${redact(e instanceof Error ? e.message : String(e))}${tail ? ` | ${tail}` : ''}`);
    }
    this.announce();
  }

  /** Only a credential-free selection: the key (if any) travels in the environment of the agent, never in this call. */
  private async authenticateIfAsked(limit: number): Promise<void> {
    const { profile, spec } = this;
    const methods = (this.init.authMethods ?? []) as Raw[];
    if ((spec.auth.mode === 'apiKey' || spec.auth.mode === 'token') && spec.auth.key && profile.keyAuthMethod && methods.some((m) => m.id === profile.keyAuthMethod)) {
      await withTimeout(this.conn.authenticate({ methodId: profile.keyAuthMethod }), limit, 'authenticate');
    }
  }

  private mcpServers(): Raw[] {
    const mcp = (this.init.agentCapabilities?.mcpCapabilities ?? {}) as Raw;
    const out: Raw[] = [];
    for (const [name, c] of Object.entries(this.spec.mcp ?? {})) {
      const cfg = c as Raw;
      if (typeof cfg.command === 'string') {
        out.push({ name, command: cfg.command, args: Array.isArray(cfg.args) ? cfg.args.map(String) : [], env: Object.entries((cfg.env ?? {}) as Raw).map(([k, v]) => ({ name: k, value: String(v) })) });
      } else if (typeof cfg.url === 'string' && (cfg.type === 'sse' ? mcp.sse : mcp.http)) {
        out.push({ type: cfg.type === 'sse' ? 'sse' : 'http', name, url: cfg.url, headers: Object.entries((cfg.headers ?? {}) as Raw).map(([k, v]) => ({ name: k, value: String(v) })) });
      }
    }
    return out;
  }

  private async openSession(limit: number): Promise<void> {
    const { spec } = this;
    const ac = (this.init.agentCapabilities ?? {}) as Raw;
    const sc = (ac.sessionCapabilities ?? {}) as Raw;
    const common = { cwd: spec.cwd, mcpServers: this.mcpServers() as never, ...(spec.addDirs.length && sc.additionalDirectories ? { additionalDirectories: spec.addDirs } : {}) };
    try {
      if (spec.resume) {
        const sessionId = spec.resume.nativeId;
        if (ac.loadSession) {
          this.loading = true; // the agent replays the history as updates; our event log already has it
          try {
            const r = await withTimeout(this.conn.loadSession({ ...common, sessionId }), limit, 'session/load') as Raw;
            this.cfg = configView(r.configOptions, r.modes);
          } finally { this.loading = false; }
        } else if (sc.resume) {
          const r = await withTimeout(this.conn.resumeSession({ ...common, sessionId }), limit, 'session/resume') as Raw;
          this.cfg = configView(r.configOptions, r.modes);
        } else {
          throw new Error(`${this.profile.name} cannot resume sessions (it offers neither session/load nor session/resume)`);
        }
        this.nativeId = sessionId;
      } else {
        const r = await withTimeout(this.conn.newSession(common), limit, 'session/new') as Raw;
        this.nativeId = String(r.sessionId);
        this.cfg = configView(r.configOptions, r.modes);
      }
    } catch (e) {
      if (e instanceof RequestError && e.code === -32000) {
        // auth_required: we never log in on the user's behalf and never handle credentials (3.3, 4.2)
        throw new AcpAuthError(`${this.profile.name} is not signed in. ${this.profile.loginHint}`);
      }
      throw e;
    }
  }

  /** Brings the agent to the role: a safe mode, the model and the thinking level; whatever cannot be applied becomes an assertion. */
  private async applyRole(limit: number): Promise<void> {
    const role = this.spec.role;
    const assertions = this.assertions;
    const setMode = async (id: string) => {
      if (this.cfg.mode) {
        await withTimeout(this.conn.setSessionConfigOption({ sessionId: this.nativeId, configId: this.cfg.mode.id, value: id }), limit, 'set mode');
        this.cfg.mode.current = id;
      } else {
        await withTimeout(this.conn.setSessionMode({ sessionId: this.nativeId, modeId: id }), limit, 'set mode');
        if (this.cfg.legacyModes) this.cfg.legacyModes.current = id;
      }
    };
    let cur = currentMode(this.cfg);
    if (cur && isUnsafeMode(cur)) {
      const safe = modeFor('ask', this.cfg) ?? modeFor('readOnly', this.cfg);
      if (safe) { await setMode(safe); cur = safe; }
    }
    if (cur && isUnsafeMode(cur)) throw new Error(`${this.profile.name} runs in the auto-approve mode "${cur}" and offers no safe mode`);
    const want = modeFor(role.permission, this.cfg);
    if (want && want !== cur) { await setMode(want); cur = want; }
    else if (!want) assertions.push(`the agent has no ${role.permission} mode; this role is enforced by the broker only`);

    if (role.model && role.model !== 'default') {
      if (!this.cfg.model) assertions.push(`the agent has no model option; "${role.model}" is not applied`);
      else {
        const v = pick(this.cfg.model.choices, role.model);
        if (!v) assertions.push(`model "${role.model}" is not offered by the agent (using ${this.cfg.model.current})`);
        else if (v !== this.cfg.model.current) await this.setOption(this.cfg.model.id, v, limit);
      }
    }
    if (role.effort) {
      if (!this.cfg.thought) assertions.push(`effort "${role.effort}" is n/a: the agent exposes no thinking-level option`);
      else {
        const r = pickEffort(this.cfg.thought.choices, role.effort);
        if (!r.value) assertions.push(`effort "${role.effort}" does not map to the agent's levels`);
        else {
          if (r.clamped) assertions.push(`effort "${role.effort}" clamped to "${r.value}"`);
          if (r.value !== this.cfg.thought.current) await this.setOption(this.cfg.thought.id, r.value, limit);
        }
      }
    }
    this.model = this.cfg.model?.current ?? role.model;
    this.caps = computeCaps(this.init as Raw, this.cfg);
    this.wireSetters();
  }

  private async setOption(configId: string, value: string, limit = INIT_TIMEOUT_MS): Promise<void> {
    const r = await withTimeout(this.conn.setSessionConfigOption({ sessionId: this.nativeId, configId, value }), limit, 'session/set_config_option') as Raw;
    this.applyConfig(r.configOptions, false);
  }

  /** Setters exist only where the negotiated options allow them ("present only when the cap says so", 1.2). */
  private wireSetters(): void {
    this.setModel = this.cfg.model ? async (id) => {
      const v = pick(this.cfg.model!.choices, id);
      if (!v) throw new Error(`model "${id}" is not offered by the agent`);
      await this.setOption(this.cfg.model!.id, v);
      this.sink.emit({ kind: 'session.info', nativeId: this.nativeId, effective: { model: v } });
    } : undefined;
    this.setEffort = this.cfg.thought ? async (level) => {
      const r = pickEffort(this.cfg.thought!.choices, level);
      if (!r.value) throw new Error(`effort "${level}" does not map to the agent's levels`);
      await this.setOption(this.cfg.thought!.id, r.value);
      this.sink.emit({ kind: 'session.info', nativeId: this.nativeId, effective: { effort: effortOf(level) } });
    } : undefined;
    this.setPermission = modeChoices(this.cfg).length ? async (mode) => {
      // automatic and bypass are Claude-only (D9): an ACP agent never runs an auto-approve mode, so a live switch to one is unsupported, not rejected
      if (mode === 'automatic' || mode === 'bypass') throw new UnsupportedModeError(`permission "${mode}" is not offered: ACP agents never run with an auto-approve mode`);
      const id = modeFor(mode, this.cfg);
      if (!id) throw new Error(`the agent has no ${mode} mode`);
      if (this.cfg.mode) await this.setOption(this.cfg.mode.id, id);
      else { await this.conn.setSessionMode({ sessionId: this.nativeId, modeId: id }); if (this.cfg.legacyModes) this.cfg.legacyModes.current = id; }
      this.sink.emit({ kind: 'session.info', nativeId: this.nativeId, effective: { permission: abstractMode(id) } });
    } : undefined;
  }

  private announce(): void {
    const { spec } = this;
    const cur = currentMode(this.cfg);
    const effort = this.cfg.thought ? effortOf(this.cfg.thought.current) : null;
    this.sink.emit({
      kind: 'session.started', nativeId: this.nativeId, model: this.model,
      effective: { permission: cur ? abstractMode(cur) : spec.role.permission, ...(effort ? { effort } : {}) },
      auth: { mode: spec.auth.mode, source: 'agent' },
      ...(this.assertions.length ? { assertions: this.assertions } : {}),
    });
    this.sink.emit({ kind: 'session.info', nativeId: this.nativeId, models: modelsOf(this.cfg) as ModelInfo[], caps: this.caps });
  }

  // ---------- config updates from the agent ----------
  private applyConfig(options: Raw[] | null | undefined, announce = true): void {
    if (!options) return;
    const modes = this.cfg.legacyModes;
    this.cfg = configView(options);
    if (!this.cfg.mode && modes) this.cfg.legacyModes = modes;
    this.model = this.cfg.model?.current ?? this.model;
    this.caps = computeCaps(this.init as Raw, this.cfg);
    this.wireSetters();
    if (announce) this.sink.emit({ kind: 'session.info', nativeId: this.nativeId, models: modelsOf(this.cfg) as ModelInfo[], caps: this.caps });
  }

  // ---------- Client handlers (agent -> us) ----------
  private client(): Client {
    return {
      requestPermission: (p) => this.requestPermission(p),
      sessionUpdate: (n) => this.sessionUpdate(n),
      readTextFile: (p) => this.readTextFile(p as Raw),
      writeTextFile: (p) => this.writeTextFile(p as Raw),
      createTerminal: (p) => this.createTerminal(p as Raw),
      terminalOutput: async (p) => this.term((p as Raw).terminalId, (id) => this.terminals.output(id)),
      waitForTerminalExit: (p) => this.termAsync((p as Raw).terminalId, (id) => this.terminals.waitForExit(id)),
      killTerminal: async (p) => this.term((p as Raw).terminalId, (id) => { this.terminals.kill(id); return {}; }),
      releaseTerminal: async (p) => this.term((p as Raw).terminalId, (id) => { this.terminals.release(id); return {}; }),
      // vendor extensions (cursor/*, _vendor/*): a clean methodNotFound so the agent's turn never waits for us
      extMethod: async (method) => { this.unknownMethods.push(method); throw RequestError.methodNotFound(method); },
      extNotification: async (method) => { this.unknownMethods.push(method); },
    };
  }

  private sessionUpdate(n: SessionNotification): void {
    if (n.sessionId !== this.nativeId) return;
    const u = n.update as Raw;
    switch (u.sessionUpdate) {
      case 'current_mode_update': {
        const id = String(u.currentModeId);
        if (this.cfg.mode) this.cfg.mode.current = id; else if (this.cfg.legacyModes) this.cfg.legacyModes.current = id;
        if (!this.loading) this.sink.emit({ kind: 'session.info', nativeId: this.nativeId, effective: { permission: abstractMode(id) } });
        return;
      }
      case 'config_option_update': if (!this.loading) this.applyConfig(u.configOptions); return;
      case 'session_info_update': if (!this.loading && typeof u.title === 'string') this.sink.emit({ kind: 'session.info', nativeId: this.nativeId, title: redact(u.title).slice(0, 200) }); return;
      case 'available_commands_update':
        // no event field for slash commands yet: they travel in raw until the contract grows one
        if (!this.loading) this.sink.emit({ kind: 'session.info', nativeId: this.nativeId, raw: redactDeep({ availableCommands: u.availableCommands }) });
        return;
      default:
    }
    // History replay during session/load, and anything that arrives while no turn is running (a late update after cancel): accepted, dropped.
    if (this.loading || !this.turnActive || this.abandoned) return;
    let first = true;
    for (const e of mapUpdate(this.map, u)) {
      this.sink.emit(first && e.kind !== 'text.delta' && e.kind !== 'thinking.delta' ? { ...e, raw: rawOf(u) } : e);
      first = false;
    }
  }

  private async requestPermission(p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const cancelled: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };
    if (p.sessionId !== this.nativeId || !this.turnActive || this.abandoned) return cancelled;
    const tc = p.toolCall as Raw;
    const toolId = String(tc.toolCallId);
    for (const e of ensureTool(this.map, tc)) this.sink.emit(e);
    // Only one-time options are ever selected; allow_always / reject_always would leave a standing rule inside the agent that bypasses us.
    const allow = p.options.find((o) => o.kind === 'allow_once');
    const reject = p.options.find((o) => o.kind === 'reject_once');
    const deny = (): RequestPermissionResponse => {
      this.map.denied.add(toolId);
      return reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : cancelled;
    };
    const intent = intentFor(tc as never, this.spec.cwd);
    const g = await this.gate(toolId, intent);
    if (!g.ok) return g.cancelled ? cancelled : deny();
    if (!allow) {
      this.audit(toolId, intent, 'default', 'the agent offered no one-time allow option');
      return deny();
    }
    return { outcome: { outcome: 'selected', optionId: allow.optionId } };
  }

  // ---------- broker ----------
  private async judge(toolId: string, intent: ToolIntent): Promise<PolicyDecision> {
    try {
      const d = await withTimeout(this.policy.decide({ agentId: this.spec.agentId, toolId, provider: this.spec.provider, intent }), POLICY_TIMEOUT_MS, 'policy/decide');
      if (!d || !['allow', 'deny', 'ask'].includes(d.decision)) return { decision: 'deny', by: 'failClosed', reason: 'malformed policy decision' };
      return d;
    } catch (e) {
      return { decision: 'deny', by: 'failClosed', reason: `policy unavailable: ${(e as Error).message}` };
    }
  }

  /** A refusal is visible as a request that resolves at once, so the Inspector shows who refused and why. */
  private audit(toolId: string, intent: ToolIntent, by: PolicyDecision['by'], reason: string): void {
    if (!this.turnActive || this.abandoned) return;
    const reqId = `perm-${toolId}-${++this.reqN}`;
    this.sink.emit({ kind: 'permission.request', reqId, toolId, intent: { ...intent, summary: `${intent.summary} (${reason})`.slice(0, 300) }, options: ['deny'] });
    this.sink.emit({ kind: 'permission.resolved', reqId, outcome: 'deny', by });
  }

  private async gate(toolId: string, intent: ToolIntent): Promise<Gate> {
    const d = await this.judge(toolId, intent);
    if (d.decision === 'allow') return { ok: true };
    if (d.decision === 'deny') {
      this.audit(toolId, intent, d.by, d.reason ?? 'refused by policy');
      return { ok: false, reason: `blocked by policy: ${d.reason ?? 'refused'} (${d.by})` };
    }
    const reqId = `perm-${toolId}-${++this.reqN}`;
    const answer = await new Promise<PermissionAnswer>((resolve) => {
      this.pending.set(reqId, { toolId, resolve: (a) => { if (this.pending.delete(reqId)) resolve(a); } });
      this.sink.emit({ kind: 'permission.request', reqId, toolId, intent, options: ['allow_once', 'deny'] });
    });
    if (this.turnActive && !this.abandoned) this.sink.emit({ kind: 'permission.resolved', reqId, outcome: answer.outcome, by: 'user' });
    if (answer.outcome === 'allow') return { ok: true };
    return { ok: false, reason: answer.outcome === 'cancelled' ? 'cancelled' : 'the user declined this action', cancelled: answer.outcome === 'cancelled' };
  }

  answer(reqId: string, answer: PermissionAnswer): void { this.pending.get(reqId)?.resolve(answer); }

  private cancelPending(): void {
    for (const p of [...this.pending.values()]) p.resolve({ outcome: 'cancelled' });
  }

  // ---------- fs/* (ours) ----------
  private refuse(toolId: string, intent: ToolIntent, e: unknown): never {
    const reason = (e as Error).message;
    this.audit(toolId, intent, 'hardStop', reason);
    throw e instanceof JailError ? RequestError.invalidParams(undefined, reason) : new RequestError(BLOCKED_CODE, reason);
  }

  private async readTextFile(p: Raw): Promise<{ content: string }> {
    const toolId = `fs-read-${++this.reqN}`;
    const intent: ToolIntent = { class: 'read', tool: 'fs/read_text_file', paths: [String(p.path)], summary: `read ${p.path}` };
    let real: string;
    try { real = this.jail.resolve(String(p.path), 'read'); } catch (e) { return this.refuse(toolId, intent, e); }
    const g = await this.gate(toolId, { ...intent, paths: [real] });
    if (!g.ok) throw new RequestError(BLOCKED_CODE, g.reason);
    try { return { content: this.jail.readText(real, p.line, p.limit) }; } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw RequestError.resourceNotFound(String(p.path));
      return this.refuse(toolId, intent, e);
    }
  }

  private async writeTextFile(p: Raw): Promise<Record<string, never>> {
    const toolId = `fs-write-${++this.reqN}`;
    const intent: ToolIntent = { class: 'write', tool: 'fs/write_text_file', paths: [String(p.path)], summary: `write ${p.path}` };
    if (this.spec.role.permission === 'readOnly') {
      this.audit(toolId, intent, 'roleDeny', 'read-only role');
      throw new RequestError(BLOCKED_CODE, 'blocked: this role is read-only');
    }
    let real: string;
    try { real = this.jail.resolve(String(p.path), 'write'); } catch (e) { return this.refuse(toolId, intent, e); }
    const g = await this.gate(toolId, { ...intent, paths: [real] });
    if (!g.ok) throw new RequestError(BLOCKED_CODE, g.reason);
    try { this.jail.writeText(real, String(p.content ?? '')); } catch (e) { return this.refuse(toolId, intent, e); }
    return {};
  }

  // ---------- terminal/* (ours) ----------
  private async createTerminal(p: Raw): Promise<{ terminalId: string }> {
    if (!p.command) throw RequestError.invalidParams(undefined, 'command is required');
    const toolId = `terminal-${++this.reqN}`;
    const intent = execIntent(String(p.command), Array.isArray(p.args) ? p.args.map(String) : undefined, 'terminal/create');
    if (this.spec.role.permission === 'readOnly') {
      this.audit(toolId, intent, 'roleDeny', 'read-only role');
      throw new RequestError(BLOCKED_CODE, 'blocked: this role is read-only');
    }
    const g = await this.gate(toolId, intent);
    if (!g.ok) throw new RequestError(BLOCKED_CODE, g.reason);
    try { return { terminalId: this.terminals.create({ command: String(p.command), args: p.args, env: p.env, cwd: p.cwd, outputByteLimit: p.outputByteLimit }) }; } catch (e) {
      if (e instanceof TerminalError) throw RequestError.invalidParams(undefined, e.message);
      throw new RequestError(-32603, `cannot start the command: ${(e as Error).message}`);
    }
  }

  private term<T>(id: unknown, f: (id: string) => T): T {
    try { return f(String(id)); } catch (e) { if (e instanceof TerminalError) throw RequestError.invalidParams(undefined, e.message); throw e; }
  }
  private async termAsync<T>(id: unknown, f: (id: string) => Promise<T>): Promise<T> {
    try { return await f(String(id)); } catch (e) { if (e instanceof TerminalError) throw RequestError.invalidParams(undefined, e.message); throw e; }
  }

  // ---------- AgentSession ----------
  prompt(input: UserInput): void {
    if (this.dead) { this.failTurn(`${this.profile.name} is not running; start a new session`); return; }
    if (this.inflight) { this.failTurn(`${this.profile.name} is still busy with the previous turn`); return; }
    resetTurn(this.map);
    this.map.terminalText = (id) => this.terminals.peek(id);
    this.turnActive = true;
    this.cancelling = false;
    this.abandoned = false;
    this.inflight = this.conn.prompt({ sessionId: this.nativeId, prompt: this.blocks(input) as ContentBlock[] }).then(
      (res) => this.promptDone(res as Raw),
      (err) => this.promptFailed(err),
    ).finally(() => { this.turnActive = false; this.inflight = undefined; });
  }

  private blocks(input: UserInput): Raw[] {
    const out: Raw[] = [];
    const ac = (this.init.agentCapabilities ?? {}) as Raw;
    const byPath: string[] = [];
    for (const a of input.attachments ?? []) {
      try {
        if (a.kind === 'image' && ac.promptCapabilities?.image) out.push({ type: 'image', data: fs.readFileSync(a.path).toString('base64'), mimeType: a.mime });
        else if (a.kind === 'text' && a.size <= MAX_INLINE_TEXT) out.push({ type: 'text', text: fenced(a.name, fs.readFileSync(a.path, 'utf8')) });
        else byPath.push(`- ${a.path} (${a.name}, ${a.size} bytes)`);
      } catch { byPath.push(`- ${a.path} (${a.name}, ${a.size} bytes)`); }
    }
    if (byPath.length) out.push({ type: 'text', text: `Attached files (read-only, read them with your file tools):\n${byPath.join('\n')}` });
    out.push({ type: 'text', text: input.text });
    return out;
  }

  private promptDone(res: Raw): void {
    if (this.abandoned || this.dead) return;
    for (const e of flushSegment(this.map)) this.sink.emit(e);
    const usage = this.usageRecord(res.usage);
    if (usage) this.sink.emit({ kind: 'usage', usage });
    // a stop the user asked for is reported as cancelled whatever word the agent used
    this.sink.emit({ kind: 'turn.end', stopReason: this.cancelling ? 'cancelled' : (STOP[String(res.stopReason)] ?? 'endTurn') });
  }

  private promptFailed(err: unknown): void {
    if (this.abandoned || this.dead) return; // the connection closed: gone() reports it once
    for (const e of flushSegment(this.map)) this.sink.emit(e);
    if (this.cancelling) { this.sink.emit({ kind: 'turn.end', stopReason: 'cancelled' }); return; }
    const isAuth = err instanceof RequestError && err.code === -32000;
    this.sink.emit({ kind: 'error', class: isAuth ? 'auth' : 'provider', message: redact(err instanceof Error ? err.message : String(err)).slice(0, 500), retryable: false });
    this.sink.emit({ kind: 'turn.end', stopReason: 'error' });
  }

  private usageRecord(u: Raw | null | undefined): UsageRecord | null {
    const ctx = this.map.ctx;
    if (!u && !ctx) return null;
    const perTurn = {
      ...zeroCounts(),
      ...(u ? { inputTokens: Number(u.inputTokens ?? 0), outputTokens: Number(u.outputTokens ?? 0), cacheRead: Number(u.cachedReadTokens ?? 0), cacheWrite: Number(u.cachedWriteTokens ?? 0), reasoningTokens: Number(u.thoughtTokens ?? 0) } : {}),
    };
    this.cumulative = addCounts(this.cumulative, perTurn);
    const costUsd = ctx?.costUsd;
    return {
      model: this.model, costBasis: costUsd !== undefined ? 'estimated' : 'unknown',
      perTurn, cumulative: { ...this.cumulative, ...(costUsd !== undefined ? { costUsd } : {}) },
      ...(ctx ? { contextUsed: ctx.used, contextSize: ctx.size } : {}),
    };
  }

  /** error + turn.end(error); used for a dead or busy session and when the process vanishes. */
  private failTurn(message: string): void {
    this.sink.emit({ kind: 'error', class: 'provider', message: redact(message).slice(0, 500), retryable: false });
    this.sink.emit({ kind: 'turn.end', stopReason: 'error' });
  }

  /** The process exited or the pipe closed. Reported once; a stop we caused (cancel escalation, close) is not an error. */
  private gone(why: string): void {
    if (this.dead) return;
    this.dead = true;
    this.cancelPending();
    void this.terminals?.killAll(this.termMs);
    if (this.closing || this.abandoned) return;
    for (const e of flushSegment(this.map)) this.sink.emit(e);
    if (this.cancelling && this.turnActive) { this.sink.emit({ kind: 'turn.end', stopReason: 'cancelled' }); return; }
    const tail = redact(this.proc.stderrTail.text.trim()).slice(-400);
    this.failTurn(tail ? `${why}: ${tail}` : why);
  }

  /**
   * session/cancel, then the soft wait (cancel protocol, 5.6). If the agent has not ended the turn by then we end it ourselves as
   * cancelled, SIGTERM the process group and every descendant, and SIGKILL what survives `termMs`. Late updates are dropped.
   */
  async interrupt(opts: InterruptOpts = {}): Promise<void> {
    if (!this.inflight || this.dead) return;
    this.cancelling = true;
    this.cancelPending();
    const settled = this.inflight;
    this.conn.cancel({ sessionId: this.nativeId }).catch(() => undefined);
    const soft = Math.max(50, (opts.softMs ?? DEFAULT_SOFT_MS) - SOFT_MARGIN_MS);
    const ended = await Promise.race([settled.then(() => true), sleep(soft).then(() => false)]);
    if (ended) return;
    this.abandoned = true;
    for (const e of flushSegment(this.map)) this.sink.emit(e);
    this.sink.emit({ kind: 'turn.end', stopReason: 'cancelled' });
    await this.killAgent(opts.termMs ?? this.termMs);
  }

  private async killAgent(termMs: number): Promise<void> {
    this.cancelPending();
    const pid = this.proc.child.pid;
    await this.terminals.killAll(termMs);
    if (pid !== undefined && this.proc.child.exitCode === null && this.proc.child.signalCode === null) await killTree(pid, termMs);
  }

  private async teardown(): Promise<void> {
    this.closing = true;
    this.cancelPending();
    await this.terminals?.killAll(500).catch(() => undefined);
    const pid = this.proc?.child.pid;
    if (pid !== undefined) await killTree(pid, 500).catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.cancelPending();
    await this.terminals.killAll(this.termMs);
    const c = this.proc.child;
    if (c.pid === undefined) return;
    // the descendants are found while the agent still lives; once it exits they would be reparented and invisible
    const tree = c.exitCode === null && c.signalCode === null ? await processTree(c.pid) : [];
    try { c.stdin?.end(); } catch { /* already closed */ }
    // an ACP agent exits when its stdin closes; give it a moment, then stop the whole tree (also what it left behind)
    await Promise.race([this.proc.exited, sleep(1500)]);
    await killTree(c.pid, this.termMs, tree);
  }
}

/** Untouched provider message for the Inspector's raw view: redacted and size-capped. */
function rawOf(u: Raw): unknown {
  const r = redactKeys(redactDeep(u));
  try {
    const json = JSON.stringify(r);
    return json.length > 8000 ? { truncated: true, preview: truncate(json, 8000) } : r;
  } catch { return undefined; }
}
