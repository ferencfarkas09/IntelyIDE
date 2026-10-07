// HistoryService: protocol handlers over a fake SDK, plus the real Agent SDK reading a fixture transcript store.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HistoryService, messageOf, type HistorySdk } from '../src/history.js';
import { ProtocolClient } from '../src/protocol.js';

function rig(load: () => Promise<HistorySdk>) {
  const sent: any[] = [];
  const proto = new ProtocolClient({ write: (l) => sent.push(JSON.parse(l)), batchMs: 1 });
  new HistoryService(proto, load);
  let n = 0;
  const call = async (type: string, body: unknown) => {
    const id = ++n;
    proto.receive(JSON.stringify({ v: 1, id, type, body }));
    for (let i = 0; i < 200; i++) {
      const r = sent.find((m) => m.type === 'reply' && m.id === id);
      if (r) return r.body;
      await new Promise((res) => setTimeout(res, 5));
    }
    throw new Error(`no reply to ${type}`);
  };
  return { call };
}

const fake = (calls: unknown[][] = []): HistorySdk => ({
  listSessions: async (o) => { calls.push(['list', o]); return [{ sessionId: 's1', summary: 'Fix the login', lastModified: 5, cwd: '/r', tag: 'wip', firstPrompt: 'key sk-ant-abcdefghijklmnop' }]; },
  getSessionMessages: async (id, o) => { calls.push(['messages', id, o]); return [{ type: 'user', uuid: 'u1', message: { content: 'hello' } }, { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Read' }] } }]; },
  tagSession: async (id, tag) => { calls.push(['tag', id, tag]); },
  renameSession: async (id, title) => { calls.push(['rename', id, title]); },
  forkSession: async (id, o) => { calls.push(['fork', id, o]); return { sessionId: 'f1' }; },
});

describe('history protocol handlers', () => {
  it('lists, reads, tags, renames and forks through the SDK, redacting secrets', async () => {
    const calls: unknown[][] = [];
    const r = rig(async () => fake(calls));
    const list = await r.call('history/list', { dir: '/r', limit: 10 });
    expect(list.ok).toBe(true);
    expect(list.sessions[0]).toMatchObject({ sessionId: 's1', summary: 'Fix the login', tag: 'wip', cwd: '/r' });
    expect(list.sessions[0].firstPrompt).toBe('key <redacted:key>');
    expect(calls[0]).toEqual(['list', { dir: '/r', limit: 10, offset: 0 }]);
    const msgs = await r.call('history/messages', { sessionId: 's1' });
    expect(msgs.messages).toEqual([{ uuid: 'u1', role: 'user', text: 'hello', tools: [] }, { uuid: 'a1', role: 'assistant', text: 'hi', tools: ['Read'] }]);
    expect(await r.call('history/tag', { sessionId: 's1', tag: ' review ' })).toEqual({ ok: true });
    expect(await r.call('history/tag', { sessionId: 's1', tag: null })).toEqual({ ok: true });
    expect(await r.call('history/rename', { sessionId: 's1', title: 'New name' })).toEqual({ ok: true });
    expect(await r.call('history/fork', { sessionId: 's1', dir: '/r', upToMessageId: 'u1' })).toEqual({ ok: true, sessionId: 'f1' });
    expect(calls.filter((c) => c[0] === 'tag').map((c) => c[2])).toEqual(['review', null]);
  });

  it('rejects malformed requests and turns SDK failures into error replies', async () => {
    const r = rig(async () => ({ ...fake(), forkSession: async () => { throw new Error('no such session with token=abcdefghij1234'); } }));
    expect(await r.call('history/messages', {})).toMatchObject({ error: 'badRequest' });
    expect(await r.call('history/rename', { sessionId: 's1', title: '  ' })).toMatchObject({ error: 'badRequest' });
    const f = await r.call('history/fork', { sessionId: 'nope' });
    expect(f.error).toBe('history');
    expect(f.detail).toContain('<redacted>');
    expect(f.detail).not.toContain('abcdefghij1234');
  });

  it('does not load the SDK before the first request', async () => {
    let loads = 0;
    const r = rig(async () => { loads++; return fake(); });
    expect(loads).toBe(0);
    await r.call('history/list', {});
    await r.call('history/list', {});
    expect(loads).toBe(1);
  });

  it('flattens text blocks and lists tool names', () => {
    expect(messageOf({ type: 'assistant', uuid: 'x', message: { content: [{ type: 'thinking' }, { type: 'tool_use', name: 'Bash' }] } })).toEqual({ uuid: 'x', role: 'assistant', text: '', tools: ['Bash'] });
  });
});

describe('the real Agent SDK on a fixture transcript store', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'intely-history-')));
  const cwd = join(root, 'repo');
  const old = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
  afterAll(() => {
    if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old;
    rmSync(root, { recursive: true, force: true });
  });

  it('lists a session started elsewhere, reads its messages, tags it and forks it', async () => {
    mkdirSync(cwd, { recursive: true });
    const dir = join(root, 'claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    const sid = '11111111-1111-4111-8111-111111111111';
    const line = (type: string, uuid: string, parent: string | null, content: unknown, t: string) =>
      JSON.stringify({ type, uuid, parentUuid: parent, sessionId: sid, timestamp: t, cwd, version: '2.0.0', isSidechain: false, userType: 'external', message: { role: type, content } });
    writeFileSync(join(dir, `${sid}.jsonl`), [
      line('user', 'u1', null, 'Rename the helper', '2026-10-03T08:00:00.000Z'),
      line('assistant', 'a1', 'u1', [{ type: 'text', text: 'Renamed.' }], '2026-10-03T08:00:05.000Z'),
    ].join('\n') + '\n');
    const r = rig(() => import('@anthropic-ai/claude-agent-sdk') as unknown as Promise<HistorySdk>);
    const list = await r.call('history/list', { dir: cwd });
    expect(list.sessions.map((s: any) => s.sessionId)).toEqual([sid]);
    expect(list.sessions[0].firstPrompt).toBe('Rename the helper');
    const msgs = await r.call('history/messages', { sessionId: sid, dir: cwd });
    expect(msgs.messages.map((m: any) => [m.role, m.text])).toEqual([['user', 'Rename the helper'], ['assistant', 'Renamed.']]);
    expect(await r.call('history/tag', { sessionId: sid, tag: 'review', dir: cwd })).toEqual({ ok: true });
    expect((await r.call('history/list', { dir: cwd })).sessions[0].tag).toBe('review');
    const fork = await r.call('history/fork', { sessionId: sid, dir: cwd });
    expect(fork.ok).toBe(true);
    expect(fork.sessionId).not.toBe(sid);
    expect((await r.call('history/list', { dir: cwd })).sessions).toHaveLength(2);
  });
});
