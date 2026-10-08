// One Claude session = one Agent SDK query in streaming-input mode (interrupt needs it) driving the installed claude CLI.
// Enforcement order (providers-plan 3.3): inline deny rules -> SDK PreToolUse hook -> policy/decide FIRST (deny on timeout or
// a malformed reply) -> canUseTool for UI prompts. Events are normalized by mapRaw(); this file only does I/O.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AgentDefinition, Options, Query, SDKUserMessage, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { buildChildEnv } from '../../env.js';
import { redact } from '../../redact.js';
import { loadSdk } from '../../sdk.js';
import type {
  AgentSession, DelegateSpec, EventSink, HostServices, McpStatusOp, McpStatusServer, PermissionAnswer, PermissionMode, PolicyClient, ResolvedRole, SessionNote, SessionSpec, UserInput,
} from '../../types.js';
import { capsFor, toModelInfo } from './caps.js';
import { effortOf, NoteError } from '../../abstract.js';
import { assertInit, checkCredential, type CliModel, findModel, initSessionInfo, isolationLeak, isWriterMode, mcpState, permissionModeFor } from './facts.js';
import { CANARY_MARK, ToolGate } from './gate.js';
import { mapRaw, type MapState, newMapState, type Raw } from './map.js';
import { IDE_MCP_NOTE, IDE_PLAN_NOTE, IDE_SESSION_NOTE } from './notes.js';
import { projectInstructions } from './project-notes.js';
import { Pushable } from './pushable.js';
import { buildContent } from './attachments.js';
import { settingsOverlay } from './settings.js';

const INIT_TIMEOUT_MS = 30_000;
const CLOSE_GRACE_MS = 3000;
const MCP_TIMEOUT_MS = 15_000;

/** Turns of a delegate whose role says nothing (Rust sends its own value; this is the fallback): a sub-agent that runs out hands back nothing. */
export const DEFAULT_DELEGATE_TURNS = 120;

/** Tools of the lead the broker would refuse anyway; not advertising them saves a wasted turn (the exact rule syntax is checked by the live smoke). */
export const LEAD_HIDDEN_AGENT_TYPES = ['general-purpose', 'Explore', 'Plan'].flatMap((t) => [`Agent(${t})`, `Task(${t})`]);

/**
 * The scratch roots of Automatic (Rust: `default_scratch_dirs`, which also refuses hidden entries and the state of other tools): a CLI
 * boundary prompt for a path there is answered from the Rust allow like one inside the run's folders.
 */
export const SCRATCH_DIRS = ['/tmp', '/private/tmp'];

/** Never offered to any session, lead or not: switching modes is the user's choice (GZ-7; Rust also denies it as `other.enter-plan`). `ToolSearch` is NOT listed: deferred MCP tools may need it. */
export const ALWAYS_HIDDEN_TOOLS = ['EnterPlanMode'];

/**
 * The tools of a session whose role lists none. NOT the CLI's `claude_code` preset: the preset of the installed CLI (2.1.284) has no
 * Glob and no Grep (it expects `find`/`grep` through Bash, which is a card per call here), and a sub-agent can only have tools its
 * lead has, so a researcher with [Read, Grep, Glob] could only Read and burned its turns without an answer. Listing the tools also
 * keeps a newer CLI from adding tools unseen. `Agent` is taken away again by `disallowedTools` where there is nobody to delegate to.
 */
export const DEFAULT_TOOLS = [
  'Agent', 'AskUserQuestion', 'Bash', 'Edit', 'ExitPlanMode', 'Glob', 'Grep', 'NotebookEdit', 'Read',
  'TaskCreate', 'TaskGet', 'TaskList', 'TaskStop', 'TaskUpdate', 'WebFetch', 'WebSearch', 'Write',
];

/** `Bash(npm test:*)` -> `Bash`: the name of a tool entry as the CLI registers it. */
const baseTool = (entry: string): string => entry.split('(')[0]!.trim();

/**
 * The `tools` option: the role's own list when it has one, else DEFAULT_TOOLS. A lead also holds every tool its roles list (a
 * sub-agent only gets what its lead has), and ToolSearch when MCP servers are configured (their deferred tools are loaded through it).
 */
export function sessionTools(role: ResolvedRole, delegates: readonly DelegateSpec[] | undefined, hasMcp: boolean): string[] {
  if (role.tools?.length) return role.tools;
  const all = new Set(DEFAULT_TOOLS);
  for (const d of delegates ?? []) for (const t of d.tools ?? []) if (baseTool(t)) all.add(baseTool(t));
  if (hasMcp) all.add('ToolSearch');
  return [...all];
}

/**
 * The SDK `agents` option from the delegates Rust resolved ((design notes: roles-orchestration-spec) 4.4). Only the fields below are ever
 * passed: never mcpServers, skills, memory, permissionMode, initialPrompt, observer or criticalSystemReminder (a role file cannot
 * widen what the IDE gives a sub-agent; the broker enforces the role's permission itself).
 */
export function buildAgents(delegates: DelegateSpec[]): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = {};
  for (const d of delegates) {
    agents[d.name] = {
      description: d.description,
      prompt: d.prompt,
      model: d.model,
      ...(d.effort ? { effort: d.effort as NonNullable<AgentDefinition['effort']> } : {}),
      ...(d.tools?.length ? { tools: d.tools } : {}),
      disallowedTools: [...new Set([...(d.disallowedTools ?? []), 'Agent', 'Task'])],
      maxTurns: d.maxTurns ?? DEFAULT_DELEGATE_TURNS,
      background: false,
      omitClaudeMd: true,
    };
  }
  return agents;
}

/** Spawns the CLI as its own process group leader so Rust can kill the CLI and its MCP children as one group (5.6). */
function spawnGrouped(host: HostServices, stderrTail: { text: string }, onSpawn: (c: ChildProcess) => void) {
  return (o: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal: AbortSignal }): SpawnedProcess => {
    const child: ChildProcess = spawn(o.command, o.args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: true, signal: o.signal });
    child.stderr?.on('data', (d: Buffer) => { stderrTail.text = (stderrTail.text + d.toString('utf8')).slice(-4000); });
    if (child.pid !== undefined) host.registerPid(child.pid);
    onSpawn(child);
    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return false;
      try { process.kill(-child.pid, sig); return true; } catch { return child.kill(sig); }
    };
    return {
      stdin: child.stdin!,
      stdout: child.stdout!,
      get killed() { return child.killed; },
      get exitCode() { return child.exitCode; },
      get signalCode() { return child.signalCode; },
      kill: killGroup,
      on: ((ev: 'exit' | 'error', fn: never) => child.on(ev, fn)) as SpawnedProcess['on'],
      once: ((ev: 'exit' | 'error', fn: never) => child.once(ev, fn)) as SpawnedProcess['once'],
      off: ((ev: 'exit' | 'error', fn: never) => child.off(ev, fn)) as SpawnedProcess['off'],
    };
  };
}

/** The tool_use ids a message of the CLI announces: a finished assistant message, or the start of a block in the partial stream. */
function toolUseIds(m: Raw): string[] {
  if (m.type === 'assistant') return (Array.isArray(m.message?.content) ? m.message.content : []).filter((b: Raw) => b?.type === 'tool_use' && typeof b.id === 'string').map((b: Raw) => b.id as string);
  if (m.type === 'stream_event' && m.event?.type === 'content_block_start' && m.event.content_block?.type === 'tool_use' && typeof m.event.content_block.id === 'string') return [m.event.content_block.id as string];
  return [];
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${what}`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

export class ClaudeSession implements AgentSession {
  readonly nativeId: string;
  private q!: Query;
  private input = new Pushable<SDKUserMessage>();
  private gate!: ToolGate;
  private state!: MapState;
  private models: CliModel[] = [];
  private appliedEffort: string | null = null;
  private foreignHooks = 0;
  private delegates?: DelegateSpec[];
  private strayKeyRemoved = false;
  /** The IDE mode this session holds; the host changes it live (`setPermission`) and an approved ExitPlanMode changes it too. Rust stays authoritative. */
  private mode: PermissionMode;
  private closed = false;
  private stderrTail = { text: '' };
  private child?: ChildProcess;
  /** Test/recorder tap: every raw SDK message before mapping. */
  onRaw?: (m: Raw) => void;

  private constructor(private spec: SessionSpec, private sink: EventSink, private policy: PolicyClient, private host: HostServices) {
    this.nativeId = spec.resume?.nativeId ?? spec.sessionId ?? randomUUID();
    this.delegates = spec.delegates?.length ? spec.delegates : undefined;
    this.mode = spec.role.permission;
  }

  static async open(spec: SessionSpec, sink: EventSink, policy: PolicyClient, host: HostServices, tap?: (m: Raw) => void): Promise<ClaudeSession> {
    if (!spec.env.claudeBin) throw new Error('session/start env.claudeBin is required (pathToClaudeCodeExecutable)');
    permissionModeFor(spec.role.permission); // refuses a mode this adapter has no SDK mapping for (`auto`, ...) before anything is spawned
    // A session that can edit files without a card per edit (edit, automatic, bypass) always runs behind the PATH git shim (docs/safety.md); the Rust host always sends it.
    if (isWriterMode(spec.role.permission) && !spec.env.shimDir) throw new Error('session/start env.shimDir is required for a session that can edit (edit, automatic and bypass): the git shim is not optional');
    const s = new ClaudeSession(spec, sink, policy, host);
    s.onRaw = tap;
    await s.start();
    return s;
  }

  private async start(): Promise<void> {
    const { spec } = this;
    // Fail closed before anything is built or spawned: no verified SDK, no run (and no CLI-only fallback without the policy hooks).
    const { query } = await loadSdk();
    const built = buildChildEnv(spec.env, spec.auth, { addDirs: spec.addDirs.length > 0 });
    this.strayKeyRemoved = spec.auth.mode === 'subscription' && built.scrubbed.includes('ANTHROPIC_API_KEY');
    this.state = newMapState({
      costBasis: spec.auth.mode === 'apiKey' ? 'estimated' : 'subscription',
      describeInit: (init) => this.describeInit(init),
      mode: () => this.mode,
    });
    const delegating = !!this.delegates;
    this.gate = new ToolGate({
      agentId: spec.agentId, provider: spec.provider, policy: this.policy, sink: this.sink, denied: this.state.denied,
      delegating, onCanary: () => this.canary(),
      mode: () => this.mode, noteMode: (m) => this.noteMode(m), lastText: () => this.state.lastText, cwd: spec.cwd, runDirs: [spec.cwd, ...spec.addDirs, ...SCRATCH_DIRS], planDir: spec.planDir,
    });
    const role: ResolvedRole = spec.role;
    const options: Options = {
      pathToClaudeCodeExecutable: spec.env.claudeBin ?? undefined,
      cwd: spec.cwd,
      model: role.model,
      ...(role.effort ? { effort: role.effort as NonNullable<Options['effort']> } : {}),
      // never `bypassPermissions` and never allowDangerouslySkipPermissions: Automatic and Bypass are `acceptEdits` here (spec 6.1)
      permissionMode: permissionModeFor(role.permission),
      settingSources: spec.settingSources ?? [],
      strictMcpConfig: true,
      mcpServers: spec.mcp as Options['mcpServers'],
      settings: settingsOverlay(spec.env, spec.denyRules ?? true, false, spec.addDirs, spec.planDir) as Options['settings'],
      // an empty list (Rust sends one for "no restriction") means the IDE default set (see DEFAULT_TOOLS), not no tools at all
      tools: sessionTools(role, this.delegates, Object.keys(spec.mcp ?? {}).length > 0),
      disallowedTools: [...new Set([...(role.disallowedTools ?? []), ...ALWAYS_HIDDEN_TOOLS, ...(delegating ? LEAD_HIDDEN_AGENT_TYPES : [])])],
      ...(role.maxTurns ? { maxTurns: role.maxTurns } : {}),
      ...(role.maxBudgetUsd ? { maxBudgetUsd: role.maxBudgetUsd } : {}),
      // the D12 note rides on EVERY session, also when the role has no prompt; the plan note too (a session can enter Plan live)
      systemPrompt: { type: 'preset', preset: 'claude_code', append: [role.systemPrompt, IDE_SESSION_NOTE, IDE_PLAN_NOTE, Object.keys(spec.mcp ?? {}).length > 0 ? IDE_MCP_NOTE : '', projectInstructions([spec.cwd, ...spec.addDirs], { includeUserMemory: spec.includeUserMemory !== false, env: spec.env.vars })].filter(Boolean).join('\n\n') },
      // The extra directories, the settings and MCP are re-passed on every open, including resume (they do not restore by themselves).
      // The directories travel inside `settings` (see settingsOverlay): the `--add-dir` flag would load the user's plugins and hooks.
      ...(spec.resume ? { resume: spec.resume.nativeId } : { sessionId: this.nativeId }),
      includePartialMessages: true,
      forwardSubagentText: true,
      includeHookEvents: true,
      env: built.env,
      ...(this.delegates ? { agents: buildAgents(this.delegates) } : {}),
      hooks: {
        PreToolUse: [{ hooks: [this.gate.preToolUse] }],
        ...(delegating ? { SubagentStart: [{ hooks: [this.gate.subagentStart] }], SubagentStop: [{ hooks: [this.gate.subagentStop] }] } : {}),
      },
      canUseTool: this.gate.canUseTool,
      spawnClaudeCodeProcess: spawnGrouped(this.host, this.stderrTail, (c) => { this.child = c; }),
    };
    this.q = query({ prompt: this.input, options });
    try {
      const ir = await withTimeout(this.q.initializationResult(), INIT_TIMEOUT_MS, 'initializationResult');
      this.models = (ir.models ?? []) as CliModel[];
      const settings = await withTimeout(((this.q as unknown as { getSettings?: () => Promise<Raw> }).getSettings?.() ?? Promise.resolve({})), 10_000, 'get_settings').catch(() => ({}) as Raw);
      this.appliedEffort = (settings as Raw).applied?.effort ?? null;
    } catch (e) {
      await this.close();
      throw new Error(`claude CLI did not initialize: ${redact((e as Error).message)}${this.stderrTail.text ? ` | ${redact(this.stderrTail.text.trim())}` : ''}`);
    }
    const entry = findModel(this.models, role.model);
    this.sink.emit({
      kind: 'session.info', nativeId: this.nativeId, models: this.models.map(toModelInfo), caps: capsFor(entry),
      ...(this.delegates ? { delegates: this.delegates.map(({ prompt: _prompt, ...info }) => info) } : {}),
    });
    void this.pump();
  }

  // ---------- facts ----------
  private describeInit(init: Raw) {
    const auth = checkCredential(this.spec.auth.mode, String(init.apiKeySource ?? 'none'), this.strayKeyRemoved);
    const assertions = assertInit({
      init,
      role: this.spec.role,
      mode: this.mode,
      mcpExpected: Object.keys(this.spec.mcp ?? {}),
      models: this.models,
      appliedEffort: this.appliedEffort,
      foreignHookEvents: this.foreignHooks,
      ...(this.delegates ? { delegateNames: this.delegates.map((d) => d.name), settingSources: this.spec.settingSources ?? [] } : {}),
    });
    return { effort: this.appliedEffort, auth, assertions };
  }

  // ---------- message pump ----------
  private async pump(): Promise<void> {
    try {
      for await (const m of this.q) this.handle(m as Raw);
      if (!this.closed) this.fail('claude process ended');
    } catch (e) {
      if (!this.closed) this.fail((e as Error).message);
    }
  }

  private handle(m: Raw): void {
    this.onRaw?.(m);
    // Fail closed: a user plugin or a foreign MCP server in the init report means the session is not isolated from the user's Claude
    // setup (its hooks can refuse tools and hold gigabytes). Nothing runs: the error is shown and the CLI is stopped.
    if (m.type === 'system' && m.subtype === 'init') {
      const leak = isolationLeak(m, Object.keys(this.spec.mcp ?? {}));
      if (leak) {
        this.fail(leak);
        void this.close();
        return;
      }
    }
    // our own hooks: PreToolUse always, SubagentStart/Stop only when delegation registered them
    const ownHook = m.hook_event === 'PreToolUse' || (!!this.delegates && (m.hook_event === 'SubagentStart' || m.hook_event === 'SubagentStop'));
    if (m.type === 'system' && typeof m.subtype === 'string' && m.subtype.startsWith('hook_') && !ownHook) {
      this.foreignHooks++;
      if (this.state.started) this.sink.emit({ kind: 'error', class: 'policy', message: `unexpected ${m.hook_event} hook event: settings isolation leaked`, retryable: false });
    }
    // canary input: tool_use blocks of messages that came from inside a sub-agent
    if (this.delegates && m.type === 'assistant' && typeof m.parent_tool_use_id === 'string') {
      for (const b of Array.isArray(m.message?.content) ? m.message.content : []) if (b?.type === 'tool_use' && typeof b.id === 'string') this.gate.noteSubagentToolUse(b.id);
    }
    // tool_use ids of the lead's own messages: a parallel call of the lead (two `Agent` calls, `Read` + `Agent`) is the lead, whichever
    // sub-agent is already running by the time its hook fires. The partial stream carries them first, the finished message again.
    // an explicit `null` parent is the lead; a message without the field is not evidence of anything (fail closed)
    if (this.delegates && m.parent_tool_use_id === null) {
      if (m.type === 'assistant') {
        for (const b of Array.isArray(m.message?.content) ? m.message.content : []) if (b?.type === 'tool_use' && typeof b.id === 'string') this.gate.noteLeadToolUse(b.id);
      } else if (m.type === 'stream_event' && m.event?.type === 'content_block_start' && m.event.content_block?.type === 'tool_use' && typeof m.event.content_block.id === 'string') {
        this.gate.noteLeadToolUse(m.event.content_block.id);
      }
    }
    // where each tool call came from (the lead, or the sub-agent an `Agent` call started): a note rides on its own target's next call
    if (typeof m.parent_tool_use_id === 'string' || m.parent_tool_use_id === null) for (const id of toolUseIds(m)) this.gate.noteToolParent(id, m.parent_tool_use_id);
    // the lead got the result of an `Agent` call, or the turn ended: no sub-agent is in flight any more (SubagentStop is not reported for
    // one that ran out of turns, which used to leave every later call of the lead attributed to an unknown actor); the notes meant for it are over too
    if (m.type === 'user' && !m.parent_tool_use_id) {
      for (const b of Array.isArray(m.message?.content) ? m.message.content : []) if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') this.gate.toolResult(b.tool_use_id);
    }
    if (m.type === 'result') this.gate.turnEnded();
    const wasStarted = this.state.started;
    for (const e of mapRaw(this.state, m)) this.sink.emit(e);
    // The CLI's slash commands and MCP servers ride in `session.info` right after the run started (optional fields: older readers skip them).
    if (m.type === 'system' && m.subtype === 'init' && !wasStarted) {
      const { slashCommands, mcpServers } = initSessionInfo(m, redact);
      if (slashCommands.length || mcpServers.length) {
        this.sink.emit({ kind: 'session.info', nativeId: this.nativeId, ...(slashCommands.length ? { slashCommands } : {}), ...(mcpServers.length ? { mcpServers } : {}) });
      }
    }
  }

  /**
   * Live MCP status (the SDK's `mcpServerStatus()`), after reconnecting or toggling one server when asked. Names, states, errors (redacted)
   * and tool names with their descriptions; never a server configuration. Throws on a CLI refusal or after 15 s.
   */
  async mcpStatus(op?: McpStatusOp): Promise<McpStatusServer[]> {
    if (op?.reconnect) await withTimeout(this.q.reconnectMcpServer(op.reconnect), MCP_TIMEOUT_MS, 'reconnectMcpServer');
    if (op?.toggle) await withTimeout(this.q.toggleMcpServer(op.toggle.server, op.toggle.enabled), MCP_TIMEOUT_MS, 'toggleMcpServer');
    const list = await withTimeout(this.q.mcpServerStatus(), MCP_TIMEOUT_MS, 'mcpServerStatus');
    return list.map((s) => ({
      name: s.name,
      status: mcpState(s.status),
      ...(s.error ? { error: redact(s.error.slice(0, 300)) } : {}),
      tools: (s.tools ?? []).slice(0, 200).map((t) => ({ name: t.name, ...(t.description ? { description: redact(t.description.slice(0, 300)) } : {}) })),
    }));
  }

  /**
   * A sub-agent's tool call reached policy without an actor: the CLI does not report agent_id the way delegation relies on.
   * Fail closed: say so (the host switches delegation off), stop the run, and let the gate deny everything from now on.
   */
  private canary(): void {
    this.sink.emit({ kind: 'error', class: 'policy', message: `${CANARY_MARK}: a sub-agent tool call carried no agent_id, so it could not be judged by its role; delegation is switched off`, retryable: false });
    void this.interrupt().catch(() => undefined);
  }

  private fail(message: string): void {
    this.gate.dropNotes('error');
    const tail = this.stderrTail.text.trim();
    this.sink.emit({ kind: 'error', class: 'provider', message: redact(tail ? `${message}: ${tail.slice(-400)}` : message), retryable: false });
    this.gate.cancelPending('cancelled');
    this.sink.emit({ kind: 'turn.end', stopReason: 'error' });
  }

  // ---------- AgentSession ----------
  prompt(input: UserInput): void {
    this.input.push({ type: 'user', message: { role: 'user', content: buildContent(input.text, input.attachments) }, parent_tool_use_id: null });
  }

  async interrupt(): Promise<void> {
    this.gate.cancelPending('cancelled');
    this.gate.dropNotes('cancelled');
    await this.q.interrupt();
  }

  /** A note for the lead (no `parentToolId`) or the running sub-agent that call started; it is delivered with that agent's next tool call. */
  note(n: SessionNote): void {
    if (this.closed) throw new NoteError('failed', 'the session is closed');
    this.gate.addNote(n);
  }

  async setModel(id: string): Promise<void> {
    await this.q.setModel(id);
    this.sink.emit({ kind: 'session.info', nativeId: this.nativeId, effective: { model: id } });
  }

  async setEffort(level: string): Promise<void> {
    await this.q.applyFlagSettings({ effortLevel: level as never });
    this.appliedEffort = level;
    this.sink.emit({ kind: 'session.info', nativeId: this.nativeId, effective: { effort: effortOf(level) } });
  }

  /**
   * Live mode switch (D8). Rust is authoritative and has already switched (the host sends Rust first, then this); the gate's and the
   * facts' view follows at once and is never reverted here: when the host rolls a loosening back it sends the old mode again. The
   * decisions the gate cached under the old mode are stale from now on (the epoch), so `canUseTool` decides them again. Repeating the
   * CURRENT mode (the host does after an MCP tightening) only advances the epoch: no CLI call, no event.
   */
  async setPermission(mode: PermissionMode): Promise<void> {
    if (mode === this.mode) { this.gate.bumpEpoch(); return; }
    const sdkMode = permissionModeFor(mode); // throws for a mode with no SDK mapping, before any state moves
    this.mode = mode;
    this.gate.bumpEpoch();
    await withTimeout(this.q.setPermissionMode(sdkMode), 5_000, 'setPermissionMode'); // throws on a CLI refusal
    this.sink.emit({ kind: 'session.info', nativeId: this.nativeId, effective: { permission: mode, reason: 'user' } });
  }

  /** An approved ExitPlanMode chose the continuation mode (the gate answers the CLI with `setMode` right after): only the sidecar's own view. */
  noteMode(mode: PermissionMode): void {
    this.mode = mode;
    this.gate.bumpEpoch();
  }

  answer(reqId: string, answer: PermissionAnswer): void { this.gate.answer(reqId, answer); }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.gate.cancelPending('cancelled');
    this.gate.dropNotes('cancelled');
    this.input.end();
    try { this.q.close(); } catch { /* already gone */ }
    const c = this.child;
    if (!c || c.exitCode !== null || c.signalCode !== null) return;
    const exited = new Promise<void>((r) => c.once('exit', () => r()));
    const grace = new Promise<void>((r) => setTimeout(r, CLOSE_GRACE_MS));
    await Promise.race([exited, grace]);
    if (c.exitCode === null && c.signalCode === null && c.pid !== undefined) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } }
  }
}
