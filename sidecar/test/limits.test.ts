// Plan limits for the Usage view: the SDK's usage answer in the view's shape, the CLI start around it, and the service that shares it.
import { describe, expect, it, vi } from 'vitest';
import { LimitsService, queryLimits, replyOf, type LimitsReply, type LimitsSdk, type RawUsage } from '../src/limits.js';
import { ProtocolClient } from '../src/protocol.js';

const RAW: RawUsage = {
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: { five_hour: { utilization: 28, resets_at: '2026-10-07T20:30:00Z' }, seven_day: { utilization: 15, resets_at: '2026-10-09T08:00:00Z' }, seven_day_opus: null },
};

function fakeSdk(over: { raw?: RawUsage | Error; init?: Error; noAsk?: boolean; hang?: boolean } = {}) {
  const calls = { options: undefined as Record<string, unknown> | undefined, closed: 0, asked: [] as unknown[] };
  const sdk: LimitsSdk = {
    query: ({ options }) => {
      calls.options = options;
      return {
        initializationResult: async () => {
          if (over.init) throw over.init;
          if (over.hang) await new Promise(() => undefined);
          return {} as never;
        },
        close: () => { calls.closed++; },
        ...(over.noAsk ? {} : { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (o: { skipBehaviors: boolean }) => { calls.asked.push(o); if (over.raw instanceof Error) throw over.raw; return over.raw ?? RAW; } }),
      } as never;
    },
  };
  return { sdk, calls };
}

describe('replyOf', () => {
  it('takes the windows the CLI reports and the plan', () => {
    expect(replyOf(RAW)).toEqual({ ok: true, plan: 'max', available: true, fiveHour: { utilization: 28, resetsAt: '2026-10-07T20:30:00Z' }, sevenDay: { utilization: 15, resetsAt: '2026-10-09T08:00:00Z' } });
  });

  it('is not available when the plan has no limits (API key, other provider) or reports nothing usable', () => {
    expect(replyOf({ subscription_type: null, rate_limits_available: false, rate_limits: null })).toEqual({ ok: true, plan: null, available: false });
    expect(replyOf({ rate_limits_available: true, rate_limits: { five_hour: { utilization: null, resets_at: null }, seven_day: { utilization: Number.NaN, resets_at: 'x' } } })).toEqual({ ok: true, plan: null, available: false });
    expect(replyOf({})).toEqual({ ok: true, plan: null, available: false });
  });

  it('keeps the per-model weeks when they exist', () => {
    const r = replyOf({ rate_limits: { seven_day_opus: { utilization: 3, resets_at: 'a' }, seven_day_sonnet: { utilization: 4, resets_at: 'b' } } });
    expect(r).toMatchObject({ available: true, sevenDayOpus: { utilization: 3 }, sevenDaySonnet: { utilization: 4 } });
  });
});

describe('queryLimits', () => {
  const req = { env: { claudeBin: '/bin/claude', vars: { PATH: '/usr/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk-ant-should-not-travel', DATABASE_URL: 'postgres://x' } }, cwd: '/state' };

  it('starts the CLI without settings, plugins or MCP, asks once without scanning transcripts, and closes it', async () => {
    const { sdk, calls } = fakeSdk();
    expect(await queryLimits(req, { sdk })).toMatchObject({ ok: true, available: true, plan: 'max' });
    expect(calls.closed).toBe(1);
    expect(calls.asked).toEqual([{ skipBehaviors: true }]);
    expect(calls.options).toMatchObject({ cwd: '/state', pathToClaudeCodeExecutable: '/bin/claude', settingSources: [], strictMcpConfig: true, mcpServers: {} });
    const env = calls.options!.env as Record<string, string>;
    expect(env.PATH).toBe('/usr/bin');
    expect(Object.keys(env)).not.toContain('ANTHROPIC_API_KEY');
    expect(Object.keys(env)).not.toContain('DATABASE_URL');
  });

  it('answers claudeNotFound without starting anything', async () => {
    const { sdk, calls } = fakeSdk();
    expect(await queryLimits({ env: { claudeBin: null } }, { sdk })).toEqual({ error: 'claudeNotFound' });
    expect(await queryLimits({ env: {} }, { sdk })).toEqual({ error: 'claudeNotFound' });
    expect(calls.options).toBeUndefined();
  });

  it('turns every failure into a reply and still closes the CLI', async () => {
    const a = fakeSdk({ init: new Error('not logged in: sk-ant-secretsecret') });
    const r = await queryLimits(req, { sdk: a.sdk });
    expect(r).toMatchObject({ error: 'failed' });
    expect(JSON.stringify(r)).not.toContain('secretsecret');
    expect(a.calls.closed).toBe(1);
    const b = fakeSdk({ raw: new Error('boom') });
    expect(await queryLimits(req, { sdk: b.sdk })).toEqual({ error: 'failed', detail: 'boom' });
    expect(b.calls.closed).toBe(1);
    const c = fakeSdk({ noAsk: true });
    expect(await queryLimits(req, { sdk: c.sdk })).toEqual({ error: 'failed', detail: 'this Claude Agent SDK has no usage request' });
    expect(c.calls.closed).toBe(1);
  });

  it('gives up after the timeout and closes the CLI', async () => {
    const { sdk, calls } = fakeSdk({ hang: true });
    expect(await queryLimits(req, { sdk, timeoutMs: 30 })).toEqual({ error: 'failed', detail: 'timeout' });
    expect(calls.closed).toBe(1);
  });
});

describe('the usage/limits service', () => {
  const rig = (ask: (r: unknown) => Promise<LimitsReply>, now = { t: 1_000_000 }) => {
    const sent: any[] = [];
    const proto = new ProtocolClient({ write: (l) => sent.push(JSON.parse(l)), batchMs: 1 });
    new LimitsService(proto, ask as never, () => now.t);
    const send = async (id: number, body: unknown = { env: { claudeBin: '/bin/claude' } }) => {
      proto.receive(JSON.stringify({ v: 1, id, type: 'usage/limits', body }));
      await new Promise((r) => setTimeout(r, 15));
      return sent.find((m) => m.id === id && m.type === 'reply')?.body;
    };
    return { send, now };
  };

  it('answers over the protocol', async () => {
    const reply: LimitsReply = replyOf(RAW);
    const { send } = rig(async () => reply);
    expect(await send(1)).toEqual(reply);
  });

  it('starts the CLI once for requests that overlap, and not again within the fresh time', async () => {
    let calls = 0;
    const ask = vi.fn(async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return replyOf(RAW); });
    const { send, now } = rig(ask);
    await Promise.all([send(1), send(2)]);
    expect(calls).toBe(1);
    now.t += 5_000;
    await send(3);
    expect(calls).toBe(1);
    now.t += 30_000;
    await send(4);
    expect(calls).toBe(2);
  });

  it('does not keep a failure: the next ask tries again', async () => {
    const answers: LimitsReply[] = [{ error: 'failed', detail: 'timeout' }, replyOf(RAW)];
    const { send } = rig(async () => answers.shift()!);
    expect(await send(1)).toEqual({ error: 'failed', detail: 'timeout' });
    expect(await send(2)).toMatchObject({ ok: true, available: true });
  });
});
