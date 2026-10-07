// The built single-file bundle against a Node fake host: standalone start, zero-cost loading, the full mock round trip,
// cancel protocol, leases and orphan protection.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { checkInvariants } from '../src/turn.js';
import { FakeHost, mockStart, SIDECAR } from '../../tests/fakes/fake-host.mjs';

const ROOT = path.resolve(__dirname, '..');
const hosts: any[] = [];
const start = async (o: Record<string, unknown> = {}) => { const h = await new FakeHost(o).start(); hosts.push(h); return h; };
beforeAll(() => { execFileSync(process.execPath, ['build.mjs'], { cwd: ROOT, stdio: 'ignore' }); });
afterEach(async () => { for (const h of hosts.splice(0)) { try { await h.stop(); } catch { /* gone */ } } });

describe('standalone bundle', () => {
  it('is one file that starts with node alone and says hello', async () => {
    expect(fs.existsSync(SIDECAR)).toBe(true);
    const h = await start({ providers: ['mock'] });
    expect(h.hello.body).toMatchObject({ providers: ['mock'], node: process.version });
    expect(h.hello.body.pid).toBeGreaterThan(0);
  });

  it('heartbeats every 2 s with the loaded adapters and session count', async () => {
    const h = await start({ providers: ['mock'] });
    await h.startSession(mockStart('a1'));
    await new Promise((r) => setTimeout(r, 4300));
    expect(h.heartbeats.length).toBeGreaterThanOrEqual(2);
    expect(h.heartbeats.at(-1).body).toMatchObject({ pid: h.hello.body.pid, loaded: ['mock'], sessions: 1 });
    const gaps = h.heartbeats.slice(1).map((b: any, i: number) => b.at - h.heartbeats[i].at);
    for (const g of gaps) expect(Math.abs(g - 2000)).toBeLessThan(500);
  }, 15000);

  it('zero cost: with providers off no adapter is loaded and a session is refused', async () => {
    const h = await start({ providers: [] });
    expect(await h.startSession(mockStart('a1'))).toMatchObject({ error: 'providerDisabled' });
    expect(await h.startSession({ ...mockStart('a2'), provider: 'claude' })).toMatchObject({ error: 'providerDisabled' });
    await new Promise((r) => setTimeout(r, 2300));
    expect(h.heartbeats.at(-1).body.loaded).toEqual([]);
    expect(h.slotCalls).toEqual([]);
  }, 15000);

  it('zero cost: with only mock enabled the Claude adapter (and the SDK behind it) is never loaded', async () => {
    const h = await start({ providers: ['mock'] });
    await h.startSession(mockStart('a1'));
    expect(await h.startSession({ ...mockStart('a2'), provider: 'claude' })).toMatchObject({ error: 'providerDisabled' });
    await new Promise((r) => setTimeout(r, 2300));
    expect(h.heartbeats.at(-1).body.loaded).toEqual(['mock']);
  }, 15000);

  it('runs a mock turn end to end: lease, gap-free batched events, permission round trip', async () => {
    const h = await start();
    expect(await h.startSession(mockStart('a1', 'tool-permission'))).toMatchObject({ ok: true, nativeId: 'mock-a1' });
    expect(h.slotCalls[0]).toMatchObject({ type: 'slot/acquire', body: { agentId: 'a1', provider: 'mock', writer: true, ttlMs: 15000 } });
    await h.prompt('a1', 'go');
    const req = await h.waitEvent('a1', (e: any) => e.kind === 'permission.request');
    await h.answer('a1', req.reqId, { outcome: 'allow' });
    const events = await h.waitTurnEnd('a1');
    expect(checkInvariants(events)).toEqual([]);
    expect(events.every((e: any) => e.provider === 'mock' && e.agentId === 'a1')).toBe(true);
    expect(events.slice(1).every((e: any) => e.turnId === 'turn-1')).toBe(true);
    const batches = h.all.filter((m: any) => m.type === 'events/batch');
    expect(Math.max(...batches.map((b: any) => b.body.events.length))).toBeLessThanOrEqual(64);
    expect(await h.closeSession('a1')).toEqual({ ok: true });
    expect(h.slotCalls.at(-1)).toMatchObject({ type: 'slot/release', body: { leaseId: 'L1' } });
  });

  it('rejects a second prompt while a turn is open and a duplicate agent id', async () => {
    const h = await start();
    await h.startSession(mockStart('a1', 'interrupt', { mock: { speed: 1 } }));
    expect(await h.startSession(mockStart('a1'))).toMatchObject({ error: 'duplicate' });
    await h.prompt('a1', 'go');
    expect(await h.prompt('a1', 'again')).toMatchObject({ error: 'turnOpen' });
    expect(await h.prompt('nobody', 'x')).toMatchObject({ error: 'noSession' });
  });

  it('cancel protocol: interrupt -> tool cancelled -> one turn.end(cancelled) -> cancel/done', async () => {
    const h = await start();
    await h.startSession(mockStart('a1', 'interrupt', { mock: { speed: 1 } }));
    await h.prompt('a1', 'go');
    await h.waitEvent('a1', (e: any) => e.kind === 'tool.start');
    expect(await h.cancel('a1', 5000, 3000)).toEqual({ ok: true });
    const events = await h.waitTurnEnd('a1');
    await h.waitFor((m: any) => m.type === 'cancel/done');
    expect(h.cancelDone[0]).toMatchObject({ agentId: 'a1', stopReason: 'cancelled' });
    expect(h.cancelDone[0].ms).toBeLessThan(1000);
    expect(events.filter((e: any) => e.kind === 'turn.end')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: 'turn.end', stopReason: 'cancelled' });
    expect(events.find((e: any) => e.kind === 'tool.result')).toMatchObject({ status: 'cancelled' });
    expect(checkInvariants(events)).toEqual([]);
    await h.prompt('a1', 'after cancel'); // the session is usable again
    await h.cancel('a1');
  });

  it('a refused lease fails the start with the Rust error and leaves no session', async () => {
    const h = await start({ slot: () => ({ error: 'noSlot', detail: 'max 3 agents' }) });
    expect(await h.startSession(mockStart('a1'))).toMatchObject({ error: 'noSlot', detail: 'max 3 agents' });
    expect(await h.prompt('a1', 'x')).toMatchObject({ error: 'noSession' });
  });

  it('a failing open reports error + turn.end(error) and releases the lease', async () => {
    const h = await start();
    expect(await h.startSession(mockStart('a1', 'does-not-exist'))).toMatchObject({ error: 'open' });
    const ev = await h.waitTurnEnd('a1');
    expect(ev.map((e: any) => e.kind)).toEqual(['error', 'turn.end']);
    expect(h.slotCalls.at(-1).type).toBe('slot/release');
  });

  it('survives garbage from the host', async () => {
    const h = await start();
    h.write('{{ not json'); h.write('{"v":9}'); h.write('');
    expect(await h.startSession(mockStart('a1'))).toMatchObject({ ok: true });
  });

  it('orphan protection: stdin EOF stops the sidecar and its sessions', async () => {
    const h = await start();
    await h.startSession(mockStart('a1', 'interrupt', { mock: { speed: 1 } }));
    await h.prompt('a1', 'go');
    await h.waitEvent('a1', (e: any) => e.kind === 'tool.start');
    expect(await h.stop()).toMatchObject({ code: 0 });
  });

  it('SIGTERM is a clean exit', async () => {
    const h = await start();
    h.kill('SIGTERM');
    expect(await h.exited).toMatchObject({ code: 0 });
  });
});
