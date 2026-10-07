// Wave4 providers wiring on the sidecar side: every provider id the Rust host can name has an adapter, the profiles added for the
// experimental providers load lazily and run against the scripted fake agent with the user-confirmed command line, and the Codex write
// switch comes from `session/start.acp.writeAllowed` (the host's computed chip or the user's per-provider override), not from the environment.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROFILES } from '../src/adapters/acp/profiles.js';
import { SidecarHost } from '../src/host.js';
import { Loader } from '../src/loader.js';
import { ProtocolClient } from '../src/protocol.js';
import { registry } from '../src/registry.js';
import { checkInvariants } from '../src/turn.js';
import type { WireEvent } from '../src/types.js';
import { rig as codexRig } from './codex-rig.js';
import { cleanTmp, FAKE, SCRIPTS, tmp, wait } from './acp-rig.js';

afterEach(cleanTmp);

// the ids crates/settings knows (experimental providers) plus claude and the scripted mock
const HOST_IDS = ['claude', 'mock', 'codex', 'gemini', 'copilot', 'opencode', 'goose', 'qwen', 'acp'];

describe('registry covers every provider the host can start', () => {
  it('has an adapter for each id and a profile for each ACP one', () => {
    for (const id of HOST_IDS) expect(Object.keys(registry), id).toContain(id);
    for (const id of ['acp', 'gemini', 'copilot', 'opencode', 'goose', 'qwen']) expect(PROFILES[id]?.id, id).toBe(id);
  });

  it('enabling providers loads nothing; the module of one imports only when a session of it opens', async () => {
    const loader = new Loader(registry, ['claude', 'opencode', 'goose', 'qwen', 'copilot', 'codex']);
    expect(loader.loaded()).toEqual([]);
    const opencode = await loader.load('opencode');
    expect(opencode.id).toBe('opencode');
    expect(opencode.kind).toBe('acp');
    expect(loader.loaded()).toEqual(['opencode']);
  });

  it('a provider that was not in --providers is refused', async () => {
    const loader = new Loader(registry, ['claude']);
    for (const id of ['codex', 'gemini', 'opencode']) await expect(loader.load(id)).rejects.toThrow(/not enabled/);
  });
});

describe('the new ACP profiles run with the confirmed command line', () => {
  for (const id of ['copilot', 'opencode', 'goose', 'qwen']) {
    it(`${id}: session/start.acp.command wins over the profile, a read-only turn completes, and nothing else is spawned`, async () => {
      const sent: any[] = [];
      const proto = new ProtocolClient({ write: (l) => sent.push(JSON.parse(l)), batchMs: 1 });
      const orig = proto.request.bind(proto);
      (proto as any).request = (type: string, body: any) => {
        if (type === 'slot/acquire') return Promise.resolve({ leaseId: 'L1', ttlMs: 15000 });
        if (type === 'slot/renew') return Promise.resolve({ ok: true });
        if (type === 'policy/decide') return Promise.resolve({ decision: 'allow', by: 'saved' });
        return orig(type as never, body);
      };
      const loader = new Loader(registry, [id]);
      const host = new SidecarHost(proto, loader);
      const send = (n: number, type: string, body: unknown) => proto.receive(JSON.stringify({ v: 1, id: n, type, body }));
      const reply = (n: number) => sent.find((m) => m.id === n && m.type === 'reply')?.body;
      const events = () => sent.filter((m) => m.type === 'events/batch').flatMap((m) => m.body.events as WireEvent[]);
      const until = async (pred: () => any) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > 8000) throw new Error('timeout'); await wait(20); } };
      send(1, 'session/start', {
        agentId: 'a1', provider: id, role: { name: 'r', model: 'default', permission: 'readOnly' }, cwd: tmp(), env: { vars: { PATH: process.env.PATH, HOME: tmp() } },
        auth: { mode: 'subscription', key: null },
        acp: { command: process.execPath, args: [FAKE, path.join(SCRIPTS, 'plain-reply.jsonl')], termMs: 300, initTimeoutMs: 4000 },
      });
      await until(() => reply(1));
      expect(reply(1)).toMatchObject({ ok: true });
      send(2, 'session/prompt', { agentId: 'a1', text: 'hi' });
      await until(() => events().some((e) => e.kind === 'turn.end'));
      expect(events().find((e) => e.kind === 'session.started')).toBeTruthy();
      expect(checkInvariants(events() as never)).toEqual([]);
      expect(loader.loaded()).toEqual([id]);
      send(3, 'session/close', { agentId: 'a1' });
      await until(() => reply(3));
      await host.shutdown();
    });
  }

  it('an agent that is not installed says so with the profile name (no spawn of anything else)', async () => {
    const loader = new Loader(registry, ['goose']);
    const p = await loader.load('goose');
    await expect(p.open({
      agentId: 'a1', provider: 'goose', role: { name: 'r', model: 'default', permission: 'readOnly' }, cwd: tmp(), addDirs: [], mcp: {}, env: { vars: { PATH: '/nonexistent' } }, auth: { mode: 'subscription', key: null },
      acp: { command: '/nonexistent/goose' },
    }, { emit() { return 0; } } as never, { decide: async () => ({ decision: 'deny', by: 'failClosed' }) } as never, { registerPid() {} })).rejects.toThrow(/not installed/);
  });
});

describe('Codex write switch comes from session/start.acp', () => {
  it('a writing role needs acp.writeAllowed (the host sets it from the chip or the weak-writer override); absent or false is refused', async () => {
    await expect(codexRig({ mode: 'edit', open: { allowWriter: undefined } })).rejects.toThrow(/read-only roles only/);
    await expect(codexRig({ mode: 'edit', open: { allowWriter: undefined }, acp: { writeAllowed: false } })).rejects.toThrow(/read-only roles only/);
    const r = await codexRig({ mode: 'edit', open: { allowWriter: undefined }, acp: { writeAllowed: true } });
    await r.cleanup();
  });

  it('writeAllowed never overrides the other refusals (git shim, INTELY_READONLY)', async () => {
    await expect(codexRig({ mode: 'edit', open: { allowWriter: undefined }, acp: { writeAllowed: true }, shimDir: null })).rejects.toThrow(/shimDir is required/);
    await expect(codexRig({ mode: 'edit', open: { allowWriter: undefined }, acp: { writeAllowed: true }, vars: { INTELY_READONLY: '1' } })).rejects.toThrow(/INTELY_READONLY/);
    await expect(codexRig({ mode: 'automatic' as never, open: { allowWriter: undefined }, acp: { writeAllowed: true } })).rejects.toThrow(/not offered/);
  });
});
