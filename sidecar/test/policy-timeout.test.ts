// `--policy-timeout=<ms>`: parsed and clamped to 1000..30000 (default 2000), and it is the wait of ProtocolClient for policy/decide.
import { describe, expect, it } from 'vitest';
import { parsePolicyTimeout, POLICY_TIMEOUT_MS, ProtocolClient } from '../src/protocol.js';

describe('parsePolicyTimeout', () => {
  it('defaults to 2000 when absent or unreadable', () => {
    expect(POLICY_TIMEOUT_MS).toBe(2000);
    for (const argv of [[], ['--providers=mock'], ['--policy-timeout='], ['--policy-timeout=abc'], ['--policy-timeout=NaN'], ['--policy-timeout=Infinity']]) expect(parsePolicyTimeout(argv)).toBe(2000);
  });
  it('uses the value and clamps it to 1000..30000', () => {
    expect(parsePolicyTimeout(['--policy-timeout=5000'])).toBe(5000);
    expect(parsePolicyTimeout(['--providers=claude', '--policy-timeout=1000'])).toBe(1000);
    expect(parsePolicyTimeout(['--policy-timeout=30000'])).toBe(30_000);
    expect(parsePolicyTimeout(['--policy-timeout=1'])).toBe(1000);
    expect(parsePolicyTimeout(['--policy-timeout=0'])).toBe(1000);
    expect(parsePolicyTimeout(['--policy-timeout=-5'])).toBe(1000);
    expect(parsePolicyTimeout(['--policy-timeout=999999'])).toBe(30_000);
    expect(parsePolicyTimeout(['--policy-timeout=2500.6'])).toBe(2501);
  });
  it('feeds ProtocolClient: with no answer the decision is a failClosed deny after about that long', async () => {
    const c = new ProtocolClient({ write: () => undefined, policyTimeoutMs: parsePolicyTimeout(['--policy-timeout=1000']) });
    const t0 = Date.now();
    const d = await c.decide({ agentId: 'a', intent: { kind: 'exec', command: 'ls' } } as never);
    expect(d).toMatchObject({ decision: 'deny', by: 'failClosed' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
    expect(Date.now() - t0).toBeLessThan(1900);
    c.close();
  });
});
