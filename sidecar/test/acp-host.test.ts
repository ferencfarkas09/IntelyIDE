// The ACP adapter through the real loader, registry and SidecarHost: zero cost when off, session/start.acp, cancel/request and the
// Gemini profile (installed-check on the PATH, API key only in the environment, nothing logged in on the user's behalf).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeAcpProvider } from '../src/adapters/acp/index.js';
import { GEMINI } from '../src/adapters/acp/profiles.js';
import { SidecarHost } from '../src/host.js';
import { Loader } from '../src/loader.js';
import { ProtocolClient } from '../src/protocol.js';
import { registry } from '../src/registry.js';
import { checkInvariants } from '../src/turn.js';
import type { WireEvent } from '../src/types.js';
import { alive, cleanTmp, FAKE, hardStopPolicy, SCRIPTS, tmp, wait } from './acp-rig.js';

afterEach(cleanTmp);

function hostRig(enabled: string[], acp: Record<string, unknown>) {
  const sent: any[] = [];
  const proto = new ProtocolClient({ write: (l) => sent.push(JSON.parse(l)), batchMs: 1 });
  const loader = new Loader(registry, enabled);
  const host = new SidecarHost(proto, loader);
  const policy = hardStopPolicy();
  const renews: any[] = [];
  const orig = proto.request.bind(proto);
  (proto as any).request = (type: string, body: any) => {
    if (type === 'slot/acquire') return Promise.resolve({ leaseId: 'L1', ttlMs: 15000 });
    if (type === 'slot/renew') { renews.push(body); return Promise.resolve({ ok: true }); }
    if (type === 'policy/decide') return policy.decide(body);
    return orig(type as never, body);
  };
  const send = (id: number, type: string, body: unknown) => proto.receive(JSON.stringify({ v: 1, id, type, body }));
  const events = () => sent.filter((m) => m.type === 'events/batch').flatMap((m) => m.body.events as WireEvent[]);
  const home = tmp();
  const start = (provider: string) => ({
    agentId: 'a1', provider, role: { name: 'r', model: 'default', permission: 'readOnly' }, cwd: tmp(), env: { vars: { PATH: process.env.PATH, HOME: home } }, auth: { mode: 'subscription', key: null }, acp,
  });
  const reply = (id: number) => sent.find((m) => m.id === id && m.type === 'reply')?.body;
  return { host, loader, sent, send, events, start, reply, renews };
}
const until = async (pred: () => any, ms = 8000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await wait(20); } };

describe('registry and loader', () => {
  it('imports no ACP module unless the provider is enabled AND a session of it opens (zero cost when off)', async () => {
    const r = hostRig(['claude'], {});
    r.send(1, 'session/start', r.start('acp'));
    await until(() => r.reply(1));
    expect(r.reply(1)).toMatchObject({ error: 'providerDisabled' });
    expect(r.loader.loaded()).toEqual([]);
    const on = hostRig(['acp', 'gemini'], {});
    expect(on.loader.loaded()).toEqual([]); // enabling alone loads nothing
  });
});

describe('session/start.acp through the host', () => {
  it('runs a turn, refuses git commit through the host policy channel, cancels an agent that ignores it, and closes without leftovers', async () => {
    const acp = (script: string) => ({ command: process.execPath, args: [FAKE, path.join(SCRIPTS, `${script}.jsonl`)], termMs: 300, initTimeoutMs: 4000 });
    const r = hostRig(['acp'], acp('asks-git-commit'));
    r.send(1, 'session/start', { ...r.start('acp'), role: { name: 'r', model: 'default', permission: 'ask' }, acp: { ...acp('asks-git-commit'), writeAllowed: true } });
    await until(() => r.reply(1));
    expect(r.reply(1)).toMatchObject({ ok: true, nativeId: 's1' });
    r.send(2, 'session/prompt', { agentId: 'a1', text: 'commit please' });
    await until(() => r.events().some((e) => e.kind === 'turn.end'));
    const ev = r.events();
    expect(ev.find((e) => e.kind === 'permission.resolved')).toMatchObject({ outcome: 'deny', by: 'hardStop' });
    expect(ev.filter((e) => e.kind === 'user.message')).toHaveLength(1);
    expect(checkInvariants(ev as never)).toEqual([]);
    r.send(3, 'session/close', { agentId: 'a1' });
    await until(() => r.reply(3));
    expect(r.sent.some((m) => m.type === 'slot/release')).toBe(true);
    expect(r.renews.length).toBeGreaterThan(0); // the agent's process group was registered for the lease
  });

  it('cancel/request on an agent that ignores session/cancel: one turn.end(cancelled), cancel/done, the group is gone', async () => {
    const a = { command: process.execPath, args: [FAKE, path.join(SCRIPTS, 'ignores-cancel.jsonl')], termMs: 300, initTimeoutMs: 4000 };
    const r = hostRig(['acp'], a);
    r.send(1, 'session/start', r.start('acp'));
    await until(() => r.reply(1));
    r.send(2, 'session/prompt', { agentId: 'a1', text: 'go' });
    await until(() => r.events().some((e) => e.kind === 'text.delta'));
    const pgid = r.renews.flatMap((b) => b.pgids)[0] as number;
    expect(pgid).toBeGreaterThan(1);
    r.send(3, 'cancel/request', { agentId: 'a1', softMs: 900, termMs: 300 });
    await until(() => r.sent.some((m) => m.type === 'cancel/done'));
    const ev = r.events();
    expect(ev.filter((e) => e.kind === 'turn.end')).toHaveLength(1);
    expect(ev.at(-1)).toMatchObject({ kind: 'turn.end', stopReason: 'cancelled' });
    expect(checkInvariants(ev as never)).toEqual([]);
    await until(() => !alive(pgid), 3000);
    r.send(4, 'session/close', { agentId: 'a1' });
    await until(() => r.reply(4));
  });

  it('a write role without writeAllowed is refused at open (readOnly roles only until proven)', async () => {
    const r = hostRig(['acp'], { command: process.execPath, args: [FAKE, path.join(SCRIPTS, 'tool-flow.jsonl')] });
    r.send(1, 'session/start', { ...r.start('acp'), role: { name: 'dev', model: 'default', permission: 'edit' } });
    await until(() => r.reply(1));
    expect(r.reply(1)).toMatchObject({ error: 'open' });
    expect(r.reply(1).detail).toMatch(/read-only roles/);
  });
});

describe('Gemini profile', () => {
  function fakeGemini() {
    const bin = tmp('intely-acp-bin-');
    const out = path.join(bin, 'launch.txt');
    fs.writeFileSync(path.join(bin, 'gemini'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "gemini 0.9.9"; exit 0; fi\nprintf '%s\\n' "$@" > ${out}\nenv | grep -E '^(GEMINI|GOOGLE|GITHUB)' >> ${out}\nexec ${process.execPath} ${FAKE} ${path.join(SCRIPTS, 'api-key-method.jsonl')}\n`, { mode: 0o755 });
    return { bin, out };
  }
  const withPath = async <T>(dir: string, f: () => Promise<T>): Promise<T> => {
    const saved = process.env.PATH;
    process.env.PATH = `${dir}:${saved}`;
    try { return await f(); } finally { process.env.PATH = saved; }
  };

  it('installed-check and version come from the PATH; not installed is reported, not thrown', async () => {
    const { bin } = fakeGemini();
    const p = makeAcpProvider(GEMINI);
    expect(await withPath(bin, () => p.detect({}))).toMatchObject({ installed: true, version: '0.9.9', path: path.join(bin, 'gemini'), auth: 'unknown' });
    const missing = makeAcpProvider({ ...GEMINI, command: 'intely-no-such-agent-xyz' });
    expect(await missing.detect({})).toMatchObject({ installed: false });
    await expect(missing.open({ agentId: 'a', provider: 'gemini', role: { name: 'r', model: 'default', permission: 'readOnly' }, cwd: tmp(), addDirs: [], env: {}, mcp: {}, auth: { mode: 'subscription', key: null } }, { emit() {} }, { decide: async () => ({ decision: 'deny', by: 'failClosed' }) }, { registerPid() {} })).rejects.toThrow(/not installed/);
  });

  it('launches `gemini --acp`; in API-key mode the key is only in the environment and authenticate carries no secret', async () => {
    const { bin, out } = fakeGemini();
    const key = 'AIzaSyFAKEFAKEFAKEFAKEFAKEFAKEFAKE12345';
    const r = hostRig(['gemini'], { termMs: 300, initTimeoutMs: 5000 });
    const log = path.join(tmp(), 'fake.log');
    r.send(1, 'session/start', { ...r.start('gemini'), auth: { mode: 'apiKey', key }, acp: { env: { FAKE_ACP_LOG: log }, termMs: 300, initTimeoutMs: 5000 } });
    await withPath(bin, async () => { await until(() => r.reply(1), 12000); });
    expect(r.reply(1)).toMatchObject({ ok: true });
    const launch = fs.readFileSync(out, 'utf8').split('\n');
    expect(launch[0]).toBe('--acp');
    expect(launch).toContain(`GEMINI_API_KEY=${key}`);
    const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const auth = lines.find((l) => l.dir === 'in' && l.m.method === 'authenticate');
    expect(auth.m.params).toEqual({ methodId: 'gemini-api-key' });
    expect(JSON.stringify(lines.filter((l) => l.dir === 'in'))).not.toContain(key);
    expect(JSON.stringify(r.sent)).not.toContain(key);
    r.send(2, 'session/close', { agentId: 'a1' });
    await until(() => r.reply(2));
  }, 30_000);

  it('subscription mode never calls authenticate and never sets a key variable', async () => {
    const { bin, out } = fakeGemini();
    const r = hostRig(['gemini'], {});
    const log = path.join(tmp(), 'fake.log');
    r.send(1, 'session/start', { ...r.start('gemini'), acp: { env: { FAKE_ACP_LOG: log }, termMs: 300, initTimeoutMs: 5000 } });
    await withPath(bin, async () => { await until(() => r.reply(1), 12000); });
    expect(r.reply(1)).toMatchObject({ ok: true });
    expect(fs.readFileSync(out, 'utf8')).not.toMatch(/GEMINI_API_KEY/);
    expect(fs.readFileSync(log, 'utf8')).not.toContain('"authenticate"');
    r.send(2, 'session/close', { agentId: 'a1' });
    await until(() => r.reply(2));
  }, 30_000);
});
