// Plan limits for the Usage view: how much of the 5 hour session and the 7 day week of the signed-in Claude subscription is used.
// Read through the Agent SDK's usage control request (the one behind Claude Code's `/usage`): the CLI starts, answers one control
// request and is closed again. No model call is made and nothing is sent to it. Stateless like `history.ts`: no open session is needed.
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { buildChildEnv } from './env.js';
import type { ProtocolClient } from './protocol.js';
import { redact } from './redact.js';
import { loadSdk, SdkError, sdkSetupHint } from './sdk.js';

export interface LimitWindow {
  /** Percent of the window used, 0 to 100. */
  utilization: number;
  /** ISO time the window resets. */
  resetsAt: string;
}

export type LimitsReply =
  | { ok: true; plan: string | null; available: boolean; fiveHour?: LimitWindow; sevenDay?: LimitWindow; sevenDayOpus?: LimitWindow; sevenDaySonnet?: LimitWindow }
  | { error: 'claudeNotFound' | 'failed'; detail?: string };

export interface LimitsRequest {
  env: { claudeBin?: string | null; vars?: Record<string, string> | null };
  /** A folder the CLI may start in (the IDE's own state folder). */
  cwd?: string;
}

/** The slice of the SDK this module uses (injectable for tests). */
export interface LimitsSdk {
  query(args: { prompt: AsyncIterable<never>; options: Record<string, unknown> }): Pick<Query, 'initializationResult' | 'close'> & { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (o: { skipBehaviors: boolean }) => Promise<RawUsage> };
}

interface RawWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

export interface RawUsage {
  subscription_type?: string | null;
  rate_limits_available?: boolean;
  rate_limits?: { five_hour?: RawWindow | null; seven_day?: RawWindow | null; seven_day_opus?: RawWindow | null; seven_day_sonnet?: RawWindow | null } | null;
}

const TIMEOUT_MS = 25_000;
/// A second ask within this time gets the answer of the first: the Usage view polls, and each ask starts the CLI.
const FRESH_MS = 20_000;

const windowOf = (w: RawWindow | null | undefined): LimitWindow | undefined =>
  w && typeof w.utilization === 'number' && Number.isFinite(w.utilization) && typeof w.resets_at === 'string' ? { utilization: w.utilization, resetsAt: w.resets_at } : undefined;

/** The reply for what the SDK answered. */
export function replyOf(raw: RawUsage): LimitsReply {
  const rl = raw.rate_limits ?? null;
  const out = { fiveHour: windowOf(rl?.five_hour), sevenDay: windowOf(rl?.seven_day), sevenDayOpus: windowOf(rl?.seven_day_opus), sevenDaySonnet: windowOf(rl?.seven_day_sonnet) };
  const available = raw.rate_limits_available !== false && Object.values(out).some(Boolean);
  return { ok: true, plan: typeof raw.subscription_type === 'string' ? raw.subscription_type : null, available, ...Object.fromEntries(Object.entries(out).filter(([, v]) => v)) };
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

/** Asks the CLI for the plan limits. Never throws: every failure is a `{ error }` reply. */
export async function queryLimits(req: LimitsRequest, o: { sdk?: LimitsSdk; timeoutMs?: number } = {}): Promise<LimitsReply> {
  const bin = req.env?.claudeBin;
  if (!bin) return { error: 'claudeNotFound' };
  let sdk: LimitsSdk;
  try {
    sdk = o.sdk ?? ((await loadSdk()) as unknown as LimitsSdk);
  } catch (e) {
    const message = redact(e instanceof Error ? e.message : String(e));
    return { error: 'failed', detail: e instanceof SdkError ? `${message}. ${sdkSetupHint()}` : message };
  }
  const never = (async function* (): AsyncGenerator<never> { await new Promise(() => undefined); })();
  const env = buildChildEnv({ claudeBin: bin, vars: req.env.vars ?? undefined }, { mode: 'subscription', key: null }, { addDirs: false }).env;
  let q: ReturnType<LimitsSdk['query']> | undefined;
  try {
    q = sdk.query({ prompt: never, options: { cwd: req.cwd ?? process.cwd(), pathToClaudeCodeExecutable: bin, settingSources: [], strictMcpConfig: true, mcpServers: {}, env } });
    const ask = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof ask !== 'function') return { error: 'failed', detail: 'this Claude Agent SDK has no usage request' };
    const live = q;
    const raw = await withTimeout((async () => { await live.initializationResult(); return ask.call(live, { skipBehaviors: true }); })(), o.timeoutMs ?? TIMEOUT_MS);
    return replyOf(raw);
  } catch (e) {
    return { error: 'failed', detail: redact(e instanceof Error ? e.message : String(e)).slice(0, 300) };
  } finally {
    try { q?.close(); } catch { /* already gone */ }
  }
}

/** `usage/limits`: the plan limits, at most one CLI start at a time and one per `FRESH_MS`. */
export class LimitsService {
  private inflight?: Promise<LimitsReply>;
  private last?: { at: number; reply: LimitsReply };

  constructor(proto: ProtocolClient, private ask: (req: LimitsRequest) => Promise<LimitsReply> = queryLimits, private now: () => number = Date.now) {
    proto.on('usage/limits', (b) => this.limits(b));
  }

  private limits(req: LimitsRequest): Promise<LimitsReply> {
    if (this.last && this.now() - this.last.at < FRESH_MS && 'ok' in this.last.reply) return Promise.resolve(this.last.reply);
    this.inflight ??= this.ask(req)
      .then((reply) => { this.last = { at: this.now(), reply }; return reply; })
      .finally(() => { this.inflight = undefined; });
    return this.inflight;
  }
}
