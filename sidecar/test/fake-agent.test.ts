// The fake-agent harness and its script format (providers-plan 5.7). The ACP/Codex adapters that consume these fakes arrive in 5b/5c;
// here the harness itself is proven: every behaviour of the 5.7 table is observable from a plain JSON-RPC client.
import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';

const AGENT = path.resolve(__dirname, '../../tests/fakes/fake-agent.mjs');
const SCRIPTS = path.resolve(__dirname, '../../tests/fakes/scripts');
const live: ChildProcess[] = [];
const grandchildren: number[] = [];

function agent(script: string) {
  const child = spawn(process.execPath, [AGENT, path.join(SCRIPTS, `${script}.jsonl`)], { stdio: ['pipe', 'pipe', 'pipe'] });
  live.push(child);
  const lines: any[] = [];
  const raw: string[] = [];
  const waiters: (() => void)[] = [];
  readline.createInterface({ input: child.stdout! }).on('line', (l) => {
    raw.push(l);
    try { lines.push(JSON.parse(l)); } catch { /* garbage kept in raw */ }
    waiters.splice(0).forEach((w) => w());
  });
  const exited = new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
  const send = (o: unknown) => child.stdin!.write(`${JSON.stringify(o)}\n`);
  const until = async (pred: () => any, ms = 4000) => {
    const t0 = Date.now();
    while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timeout; saw ${raw.join(' | ')}`); await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 25); }); }
    return pred();
  };
  const rpc = async (id: number, method: string, params: unknown = {}) => { send({ jsonrpc: '2.0', id, method, params }); return until(() => lines.find((m) => m.id === id && !m.method)); };
  return { child, lines, raw, send, until, rpc, exited };
}
afterEach(() => {
  for (const c of live.splice(0)) c.kill('SIGKILL');
  for (const p of grandchildren.splice(0)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
});

describe('fake agent harness', () => {
  it('asks permission for git commit and waits for the client answer', async () => {
    const a = agent('acp-asks-git-commit');
    expect((await a.rpc(1, 'initialize')).result.protocolVersion).toBe(1);
    expect((await a.rpc(2, 'session/new')).result.sessionId).toBe('s1');
    a.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: {} });
    const req = await a.until(() => a.lines.find((m) => m.method === 'session/request_permission'));
    expect(req.params.toolCall.title).toBe('git commit -m x');
    expect(a.lines.some((m) => m.method === 'fake/prompt_done')).toBe(false); // blocked on the answer
    a.send({ jsonrpc: '2.0', id: req.id, result: { outcome: { outcome: 'selected', optionId: 'reject' } } });
    expect((await a.until(() => a.lines.find((m) => m.method === 'fake/prompt_done'))).params.stopReason).toBe('end_turn');
  });

  it('calls terminal/create with an absolute-path git push', async () => {
    const a = agent('acp-terminal-git-push');
    await a.rpc(1, 'initialize'); await a.rpc(2, 'session/new');
    a.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: {} });
    const t = await a.until(() => a.lines.find((m) => m.method === 'terminal/create'));
    expect(t.params).toMatchObject({ command: '/usr/bin/git', args: ['push', 'origin', 'HEAD'] });
  });

  it('ignores session/cancel and never ends the turn', async () => {
    const a = agent('acp-ignores-cancel');
    await a.rpc(1, 'initialize'); await a.rpc(2, 'session/new');
    a.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: {} });
    await a.until(() => a.lines.find((m) => m.method === 'session/update'));
    a.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's1' } });
    await new Promise((r) => setTimeout(r, 300));
    expect(a.lines.some((m) => m.id === 3)).toBe(false);
    expect(a.child.exitCode).toBeNull();
    a.child.kill('SIGTERM'); // the escalation the host performs
    expect(await a.exited).toBeNull();
  });

  it('hangs without answering initialize', async () => {
    const a = agent('acp-hangs');
    a.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await new Promise((r) => setTimeout(r, 300));
    expect(a.lines).toEqual([]);
  });

  it('spawns a detached grandchild and announces its pid', async () => {
    const a = agent('acp-spawns-grandchild');
    const g = await a.until(() => a.lines.find((m) => m.fake === 'grandchild'));
    grandchildren.push(g.pid);
    expect(() => process.kill(g.pid, 0)).not.toThrow();
    a.child.kill('SIGKILL');
    await a.exited;
    expect(() => process.kill(g.pid, 0)).not.toThrow(); // survives its parent: this is what the process-tree reaper must catch
  });

  it('sends unknown vendor requests and garbage lines', async () => {
    const a = agent('acp-unknown-vendor-method');
    await a.rpc(1, 'initialize'); await a.rpc(2, 'session/new');
    a.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: {} });
    const v1 = await a.until(() => a.lines.find((m) => m.method === 'cursor/ask_question'));
    a.send({ jsonrpc: '2.0', id: v1.id, result: {} });
    await a.until(() => a.raw.includes('this is not json'));
    const v2 = await a.until(() => a.lines.find((m) => m.method === '_vendor/thing'));
    a.send({ jsonrpc: '2.0', id: v2.id, error: { code: -32601, message: 'method not found' } });
    expect((await a.until(() => a.lines.find((m) => m.method === 'fake/prompt_done'))).params.stopReason).toBe('end_turn');
  });

  it('honours cancel, then sends a late update after the turn ended', async () => {
    const a = agent('acp-late-update-after-cancel');
    await a.rpc(1, 'initialize'); await a.rpc(2, 'session/new');
    a.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: {} });
    await a.until(() => a.lines.find((m) => m.params?.update?.sessionUpdate === 'tool_call'));
    a.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's1' } });
    expect((await a.until(() => a.lines.find((m) => m.method === 'fake/prompt_done'))).params.stopReason).toBe('cancelled');
    const late = await a.until(() => a.lines.find((m) => m.params?.update?.sessionUpdate === 'tool_call_update'));
    expect(late.params.update.status).toBe('completed');
  });

  it('crashes mid-turn with exit code 3', async () => {
    const a = agent('acp-crashes-mid-turn');
    await a.rpc(1, 'initialize'); await a.rpc(2, 'session/new');
    a.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: {} });
    await a.until(() => a.lines.find((m) => m.method === 'session/update'));
    expect(await a.exited).toBe(3);
  });
});
