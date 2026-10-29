// The live model list for New run and Settings > Roles: every model the installed claude CLI offers, with the effort levels each one
// takes. Read from the CLI's `initialize` answer (the same catalog the claude-sdk adapter's `listModels` reads): the CLI starts, answers
// and is closed again. No model call is made and nothing is sent to one. Stateless like `limits.ts`: no open session is needed.
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { toModelInfo } from './adapters/claude-sdk/caps.js';
import type { CliModel } from './adapters/claude-sdk/facts.js';
import { settingsOverlay } from './adapters/claude-sdk/settings.js';
import { buildChildEnv } from './env.js';
import type { ProtocolClient } from './protocol.js';
import { redact } from './redact.js';
import { loadSdk, SdkError, sdkSetupHint } from './sdk.js';
import type { ModelInfo } from './types.js';

export type ModelsReply = { ok: true; models: ModelInfo[] } | { error: 'claudeNotFound' | 'failed'; detail?: string };

export interface ModelsRequest {
  env: { claudeBin?: string | null; vars?: Record<string, string> | null };
  /** A folder the CLI may start in (the IDE's own state folder). */
  cwd?: string;
  /** How long the whole ask may take; the host waits a little longer. */
  timeoutMs?: number;
}

/** The slice of the SDK this module uses (injectable for tests). */
export interface ModelsSdk {
  query(args: { prompt: AsyncIterable<never>; options: Record<string, unknown> }): Pick<Query, 'initializationResult' | 'close'>;
}

const TIMEOUT_MS = 15_000;
/** At most this many models are passed on: the list feeds a dropdown, never a loop. */
const MAX_MODELS = 64;

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

/** The CLI's catalog as the wire's `ModelInfo`: ids and labels that are not plain text are dropped, the effort levels are kept as reported. */
export function modelsOf(raw: unknown): ModelInfo[] {
  const list = Array.isArray(raw) ? (raw as CliModel[]) : [];
  const out: ModelInfo[] = [];
  for (const m of list) {
    if (!m || typeof m.value !== 'string' || !m.value || m.value.length > 128) continue;
    const info = toModelInfo(m);
    out.push({ ...info, label: info.label.slice(0, 80), effortLevels: (info.effortLevels ?? []).filter((l) => typeof l === 'string' && l.length <= 16) });
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

/** Asks the CLI for its models. Never throws: every failure is a `{ error }` reply. */
export async function queryModels(req: ModelsRequest, o: { sdk?: ModelsSdk } = {}): Promise<ModelsReply> {
  const bin = req.env?.claudeBin;
  if (!bin) return { error: 'claudeNotFound' };
  let sdk: ModelsSdk;
  try {
    sdk = o.sdk ?? ((await loadSdk()) as unknown as ModelsSdk);
  } catch (e) {
    const message = redact(e instanceof Error ? e.message : String(e));
    return { error: 'failed', detail: e instanceof SdkError ? `${message}. ${sdkSetupHint()}` : message };
  }
  const never = (async function* (): AsyncGenerator<never> { await new Promise(() => undefined); })();
  const env = buildChildEnv({ claudeBin: bin, vars: req.env.vars ?? undefined }, { mode: 'subscription', key: null }, { addDirs: false }).env;
  let q: ReturnType<ModelsSdk['query']> | undefined;
  try {
    // isolated like a session: no user settings, plugins, hooks or MCP servers are loaded for this
    q = sdk.query({ prompt: never, options: { cwd: req.cwd ?? process.cwd(), pathToClaudeCodeExecutable: bin, settingSources: [], strictMcpConfig: true, mcpServers: {}, settings: settingsOverlay({}), env } });
    const live = q;
    const ir = await withTimeout(live.initializationResult(), Math.min(Math.max(req.timeoutMs ?? TIMEOUT_MS, 1000), 60_000));
    return { ok: true, models: modelsOf((ir as { models?: unknown }).models) };
  } catch (e) {
    return { error: 'failed', detail: redact(e instanceof Error ? e.message : String(e)).slice(0, 300) };
  } finally {
    try { q?.close(); } catch { /* already gone */ }
  }
}

/** `models/list`: the live model list, at most one CLI start at a time (the host caches the answer). */
export class ModelsService {
  private inflight?: Promise<ModelsReply>;

  constructor(proto: ProtocolClient, private ask: (req: ModelsRequest) => Promise<ModelsReply> = queryModels) {
    proto.on('models/list', (b) => this.list(b));
  }

  private list(req: ModelsRequest): Promise<ModelsReply> {
    this.inflight ??= this.ask(req).finally(() => { this.inflight = undefined; });
    return this.inflight;
  }
}
