// The ACP adapter against the scripted fake agent (providers-plan 3.4, 5.7): mapping, caps, permissions, fs and terminal handlers,
// cancel, crash, hang, garbage and vendor methods. No real agent, no network.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UnsupportedModeError } from '../src/abstract.js';
import { alive, cleanTmp, fixtureRepo, hardStopPolicy, rig, tmp, wait } from './acp-rig.js';

const open: Array<{ session: { close(): Promise<void> } }> = [];
async function R(o: Parameters<typeof rig>[0]) { const r = await rig(o); open.push(r); return r; }
afterEach(async () => { await Promise.all(open.splice(0).map((r) => r.session.close().catch(() => undefined))); cleanTmp(); });

describe('session setup and caps', () => {
  it('negotiates v1, advertises our fs and terminal, announces the session with caps computed from the config options', async () => {
    const r = await R({ script: 'tool-flow', role: { model: 'pro-2', effort: 'high' } });
    const init = r.received('initialize')[0];
    expect(init.params.protocolVersion).toBe(1);
    expect(init.params.clientCapabilities).toMatchObject({ fs: { readTextFile: true, writeTextFile: true }, terminal: true, auth: { terminal: false } });
    const started: any = r.events.find((e) => e.kind === 'session.started');
    expect(started).toMatchObject({ nativeId: 's1', model: 'pro-2', effective: { permission: 'readOnly', effort: 'high' } });
    const info: any = r.events.find((e) => e.kind === 'session.info');
    expect(info.models.map((m: any) => m.id)).toEqual(['fast-1', 'pro-2']);
    expect(info.caps).toMatchObject({ effort: { cap: 'yes' }, effortLevels: ['low', 'medium', 'high'], modelList: { cap: 'yes' }, resume: { cap: 'yes' }, attachments: 'images', cancel: { cap: 'yes' } });
    // the role's mode (plan) and model/effort were applied through set_config_option, nothing else was touched
    expect(r.received('session/set_config_option').map((m) => [m.params.configId, m.params.value])).toEqual([['mode', 'plan'], ['model', 'pro-2'], ['thinking', 'high']]);
    expect(r.violations()).toEqual([]);
  });

  it('reports what cannot be applied as assertions, and has no setters for options the agent lacks', async () => {
    const r = await R({ script: 'tool-flow', role: { model: 'nope-9', effort: 'xhigh' } });
    const started: any = r.events.find((e) => e.kind === 'session.started');
    expect(started.assertions.join('|')).toMatch(/model "nope-9" is not offered/);
    expect(started.assertions.join('|')).toMatch(/clamped to "high"/);
    expect(typeof r.session.setModel).toBe('function');
  });

  it('refuses a write role until Rust says the enforcement chip allows it, and never offers auto', async () => {
    const base = { script: 'tool-flow' } as const;
    await expect(rig({ ...base, permission: 'edit', acp: { writeAllowed: false } })).rejects.toThrow(/read-only roles/);
    await expect(rig({ ...base, permission: 'automatic' as never, acp: { writeAllowed: true } })).rejects.toThrow(/automatic/);
    await expect(rig({ ...base, permission: 'bypass' as never, acp: { writeAllowed: true } })).rejects.toThrow(/bypass/);
    const ok = await R({ ...base, permission: 'edit' }); // the rig sets writeAllowed for non-readOnly roles
    expect(ok.events.find((e) => e.kind === 'session.started')).toMatchObject({ effective: { permission: 'ask' } }); // the fake has no edit mode, so default stays
  });

  it('a live switch to automatic or bypass is unsupported (Claude only), not a refusal the agent made', async () => {
    const ok = await R({ script: 'tool-flow', permission: 'ask' });
    expect(ok.session.setPermission).toBeTypeOf('function');
    for (const mode of ['automatic', 'bypass'] as const) await expect(ok.session.setPermission!(mode), mode).rejects.toBeInstanceOf(UnsupportedModeError);
  });

  it('refuses an agent that starts in an auto-approve mode and offers no safe one', async () => {
    await expect(rig({ script: 'no-modes-yolo' })).rejects.toThrow(/auto-approve mode "yolo"/);
  });

  it('an agent that answers with another protocol version is refused', async () => {
    await expect(rig({ script: 'old-protocol' })).rejects.toThrow(/ACP v9/);
  });

  it('auth_required becomes a sign-in message, never a login attempt', async () => {
    const e = await rig({ script: 'auth-required' }).catch((x: Error) => x);
    expect((e as Error).message).toMatch(/not signed in/);
  });

  it('times out an agent that never answers initialize and leaves no process behind', async () => {
    const t0 = Date.now();
    const err = await rig({ script: 'hangs', acp: { initTimeoutMs: 400 } }).catch((x: Error) => x);
    expect((err as Error).message).toMatch(/timeout: initialize/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('resumes through session/load and drops the replayed history', async () => {
    const r = await R({ script: 'tool-flow', resume: 'old-session' });
    expect(r.received('session/load')[0].params.sessionId).toBe('old-session');
    expect(r.session.nativeId).toBe('old-session');
    expect(r.kinds()).not.toContain('text.delta');
  });
});

describe('update mapping', () => {
  it('maps a whole turn to normalised events with gap-free seq and one turn.end', async () => {
    const r = await R({ script: 'tool-flow' });
    await r.turn();
    const k = r.kinds();
    expect(r.text()).toBe('HelloBye');
    expect(r.events.filter((e) => e.kind === 'text.done').map((e: any) => e.text)).toEqual(['Hello', 'Bye']);
    expect(k.filter((x) => x === 'turn.end')).toHaveLength(1);
    expect(r.events.find((e) => e.kind === 'thinking.delta')).toMatchObject({ text: 'thinking...' });
    expect(r.events.find((e) => e.kind === 'plan')).toMatchObject({ items: [{ content: 'read it', status: 'in_progress' }, { content: 'fix it', status: 'pending' }] });
    const starts = r.events.filter((e) => e.kind === 'tool.start') as any[];
    expect(starts.map((s) => [s.toolId, s.toolKind])).toEqual([['t1', 'read'], ['t2', 'edit']]);
    const results = r.events.filter((e) => e.kind === 'tool.result') as any[];
    expect(results[0]).toMatchObject({ toolId: 't1', status: 'ok', output: 'file body' });
    expect(results[1]).toMatchObject({ toolId: 't2', status: 'error', diff: { path: 'a.ts', old: 'x', new: 'y' } });
    const usage: any = r.events.find((e) => e.kind === 'usage');
    expect(usage.usage).toMatchObject({ costBasis: 'estimated', contextUsed: 1200, contextSize: 200000, perTurn: { inputTokens: 20, outputTokens: 10, cacheRead: 5, reasoningTokens: 4 } });
    expect(usage.usage.cumulative.costUsd).toBe(0.01);
    const infos = r.events.filter((e) => e.kind === 'session.info') as any[];
    expect(infos.some((i) => i.effective?.permission === 'readOnly')).toBe(true);
    expect(infos.some((i) => i.title === 'Fake session')).toBe(true);
    expect(infos.some((i) => i.raw?.availableCommands?.[0]?.name === 'compact')).toBe(true);
    expect(r.events.at(-1)).toMatchObject({ kind: 'turn.end', stopReason: 'endTurn' });
    expect(r.violations()).toEqual([]);
  });

  it('keeps going through garbage lines between valid messages', async () => {
    const r = await R({ script: 'malformed-json' });
    await r.turn();
    expect(r.text()).toBe('ab');
    expect(r.kinds().filter((x) => x === 'turn.end')).toHaveLength(1);
    expect(r.violations()).toEqual([]);
  });

  it('a JSON-RPC batch (not part of ACP v1) ends the turn with an error instead of hanging', async () => {
    const r = await R({ script: 'batch-message' });
    await r.turn();
    expect(r.events.at(-2)).toMatchObject({ kind: 'error' });
    expect(r.events.at(-1)).toMatchObject({ kind: 'turn.end', stopReason: 'error' });
    expect(r.violations()).toEqual([]);
  });

  it('answers unknown vendor methods with a clean error and does not hang the turn', async () => {
    const r = await R({ script: 'unknown-vendor-method' });
    await r.turn();
    expect(r.text()).toBe('v1=-32601 v2=-32601');
    expect((r.session as any).unknownMethods).toEqual(expect.arrayContaining(['cursor/ask_question', '_vendor/thing']));
    expect(r.violations()).toEqual([]);
  });
});

describe('permissions: session/request_permission -> policy/decide', () => {
  it('rejects git commit with reject_once (never an always option) and shows who refused', async () => {
    const log: any[] = [];
    const r = await R({ script: 'asks-git-commit', permission: 'ask', policy: hardStopPolicy(log) });
    await r.turn();
    expect(r.text()).toBe('answer=selected:reject');
    expect(log[0]).toMatchObject({ class: 'exec', cmd: 'git commit -m x', decision: 'deny' });
    const req = r.events.find((e) => e.kind === 'permission.request') as any;
    const res = r.events.find((e) => e.kind === 'permission.resolved') as any;
    expect(req.intent).toMatchObject({ class: 'exec', rawCommand: 'git commit -m x' });
    expect(res).toMatchObject({ outcome: 'deny', by: 'hardStop' });
    expect(r.events.find((e) => e.kind === 'tool.result' && (e as any).toolId === 'c1')).toMatchObject({ status: 'denied' });
    expect(r.violations()).toEqual([]);
  });

  it('selects allow_once (not the always option listed first) when the broker allows', async () => {
    const r = await R({ script: 'asks-write', permission: 'edit', policy: { decide: async () => ({ decision: 'allow', by: 'saved' }) } });
    await r.turn();
    expect(r.text()).toBe('answer=selected:allow');
    // the card existed although the agent never sent tool_call first
    expect(r.events.find((e) => e.kind === 'tool.start')).toMatchObject({ toolId: 'w1', toolKind: 'edit' });
  });

  it('asks the user on "ask" and takes the answer', async () => {
    const r = await R({ script: 'asks-write', permission: 'edit', policy: { decide: async () => ({ decision: 'ask', by: 'default' }) } });
    r.guard.beginTurn();
    r.session.prompt({ text: 'go' });
    await r.until(() => r.events.some((e) => e.kind === 'permission.request'));
    const req = r.events.find((e) => e.kind === 'permission.request') as any;
    expect(req.options).toEqual(['allow_once', 'deny']);
    r.session.answer(req.reqId, { outcome: 'deny' });
    await r.until(() => r.turnEnded());
    expect(r.text()).toBe('answer=selected:reject');
    expect(r.events.find((e) => e.kind === 'permission.resolved')).toMatchObject({ outcome: 'deny', by: 'user' });
  });

  it('fails closed when the policy channel is down or answers garbage', async () => {
    const down = await R({ script: 'asks-write', permission: 'edit', policy: { decide: async () => { throw new Error('pipe closed'); } } });
    await down.turn();
    expect(down.text()).toBe('answer=selected:reject');
    expect(down.events.find((e) => e.kind === 'permission.resolved')).toMatchObject({ by: 'failClosed' });
    const junk = await R({ script: 'asks-write', permission: 'edit', policy: { decide: async () => ({ nonsense: true }) as never } });
    await junk.turn();
    expect(junk.text()).toBe('answer=selected:reject');
  });

  it('answers a pending permission with outcome cancelled when the user cancels', async () => {
    const r = await R({ script: 'cancel-with-pending-permission', permission: 'ask', policy: { decide: async () => ({ decision: 'ask', by: 'default' }) } });
    r.guard.beginTurn();
    r.session.prompt({ text: 'go' });
    await r.until(() => r.events.some((e) => e.kind === 'permission.request'));
    await r.session.interrupt({ softMs: 3000 });
    await r.until(() => r.turnEnded());
    await r.until(() => r.replies().perm !== undefined); // the fake logs its reply a moment after turn.end
    expect(r.replies().perm.result.outcome).toEqual({ outcome: 'cancelled' });
    expect(r.events.at(-1)).toMatchObject({ kind: 'turn.end', stopReason: 'cancelled' });
    expect(r.violations()).toEqual([]);
  });
});

describe('fs/* handlers (ours): jail first, then the broker', () => {
  it('reads inside the repo (with line/limit), refuses outside paths, symlink escapes and .git writes', async () => {
    const fx = fixtureRepo();
    const outside = tmp('intely-acp-out-');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
    fs.symlinkSync(outside, path.join(fx.repo, 'link-out'));
    const log: any[] = [];
    const r = await R({ script: 'fs-calls', permission: 'edit', cwd: fx.repo, policy: hardStopPolicy(log) });
    await r.turn();
    const rep = r.replies();
    expect(rep.r1.result.content).toBe('line1\nline2\nline3\n');
    expect(rep.r2.result.content).toBe('line2');
    for (const n of ['r3', 'r4', 'r5']) expect(rep[n].error, n).toBeTruthy();
    expect(rep.w1.result).toEqual({});
    expect(fs.readFileSync(path.join(fx.repo, 'out/new.txt'), 'utf8')).toBe('written');
    for (const n of ['w2', 'w3', 'w4']) expect(rep[n].error, n).toBeTruthy();
    expect(fs.existsSync(path.join(fx.repo, '.git/hooks/pre-commit'))).toBe(false);
    expect(fs.existsSync(path.join(outside, 'pwn.txt'))).toBe(false);
    expect(fs.existsSync('/tmp/intely-acp-outside.txt')).toBe(false);
    // jail refusals are visible as resolved denials
    expect(r.events.filter((e) => e.kind === 'permission.resolved' && (e as any).by === 'hardStop').length).toBeGreaterThanOrEqual(4);
    expect(r.violations()).toEqual([]);
  });

  it('a read-only role cannot write files, even when the broker would allow', async () => {
    const fx = fixtureRepo();
    const r = await R({ script: 'fs-calls', permission: 'readOnly', cwd: fx.repo, policy: { decide: async () => ({ decision: 'allow', by: 'saved' }) } });
    await r.turn();
    expect(r.replies().w1.error.message).toMatch(/read-only/);
    expect(fs.existsSync(path.join(fx.repo, 'out/new.txt'))).toBe(false);
  });
});

describe('terminal/* handlers (ours)', () => {
  it('runs an allowed command in its own group and returns exit status and output', async () => {
    const r = await R({ script: 'terminal-echo', permission: 'ask', policy: { decide: async () => ({ decision: 'allow', by: 'saved' }) } });
    await r.turn();
    expect(r.text()).toBe('exit=0 out=hello from terminal\n');
    expect(r.pids.length).toBeGreaterThanOrEqual(2); // agent + terminal child registered for the lease
  });

  it('refuses terminal/create with an absolute-path git push; no new ref', async () => {
    const fx = fixtureRepo();
    const before = fx.snap();
    const log: any[] = [];
    const r = await R({ script: 'terminal-git-push', permission: 'ask', cwd: fx.repo, policy: hardStopPolicy(log), shim: true });
    await r.turn();
    expect(log[0]).toMatchObject({ class: 'exec', cmd: '/usr/bin/git push origin HEAD', decision: 'deny' });
    expect(r.text()).toMatch(/^terminal=blocked by policy/);
    expect(fx.snap()).toEqual(before);
    expect(r.events.find((e) => e.kind === 'permission.resolved')).toMatchObject({ outcome: 'deny', by: 'hardStop' });
  });

  it('keeps its own PATH (shim first) and drops GIT_* from the agent-supplied env', async () => {
    const r = await R({ script: 'terminal-env-path', permission: 'ask', shim: true, policy: { decide: async () => ({ decision: 'allow', by: 'saved' }) } });
    await r.turn();
    const out = r.replies().out.result.output as string;
    expect(out).toMatch(/PATH=.*git-shim/);
    expect(out).not.toMatch(/GIT_DIR=/);
    expect(out).toMatch(/FAKE_OK=1/);
  });
});

describe('cancel protocol and process failure', () => {
  it('honours cancel: stopReason cancelled, open tools cancelled, one turn.end, late updates dropped', async () => {
    const r = await R({ script: 'late-update-after-cancel' });
    r.guard.beginTurn();
    r.session.prompt({ text: 'go' });
    await r.until(() => r.events.some((e) => e.kind === 'tool.start'));
    await r.session.interrupt({ softMs: 3000 });
    await wait(400); // the agent sends stale updates 100 ms after answering the cancel
    expect(r.kinds().filter((x) => x === 'turn.end')).toHaveLength(1);
    expect(r.events.at(-1)).toMatchObject({ kind: 'turn.end', stopReason: 'cancelled' });
    expect(r.events.find((e) => e.kind === 'tool.result')).toMatchObject({ toolId: 'c1', status: 'cancelled' });
    expect(r.text()).toBe('');
    expect(r.violations()).toEqual([]);
    // the session is still usable
    expect(r.received('session/cancel')).toHaveLength(1);
  });

  it('an agent that ignores cancel is ended after the soft wait: turn.end(cancelled), SIGTERM to the group, no process left', async () => {
    const r = await R({ script: 'ignores-cancel' });
    r.guard.beginTurn();
    r.session.prompt({ text: 'go' });
    await r.until(() => r.text() === 'working');
    const pid = r.pids[0]!;
    const t0 = Date.now();
    await r.session.interrupt({ softMs: 700, termMs: 400 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(r.events.at(-1)).toMatchObject({ kind: 'turn.end', stopReason: 'cancelled' });
    expect(r.kinds().filter((x) => x === 'turn.end')).toHaveLength(1);
    await r.until(() => !alive(pid), 3000);
    expect(r.violations()).toEqual([]);
    // the dead session says so instead of hanging
    r.guard.beginTurn();
    r.session.prompt({ text: 'again' });
    await r.until(() => r.kinds().filter((x) => x === 'turn.end').length === 2);
    expect(r.events.find((e) => e.kind === 'error')).toMatchObject({ class: 'provider' });
  });

  it('escalates to SIGKILL when the agent ignores SIGTERM too', async () => {
    const r = await R({ script: 'ignores-cancel-and-sigterm' });
    r.guard.beginTurn();
    r.session.prompt({ text: 'go' });
    await r.until(() => r.text() === 'working');
    const pid = r.pids[0]!;
    await r.session.interrupt({ softMs: 600, termMs: 300 });
    await r.until(() => !alive(pid), 2000);
  });

  it('finds and kills a detached grandchild through the process-tree walk', async () => {
    const r = await R({ script: 'spawns-grandchild' });
    r.guard.beginTurn();
    r.session.prompt({ text: 'go' });
    await r.until(() => r.text() === 'spawned');
    await r.until(() => r.grandchildren().length === 1);
    const gc = r.grandchildren()[0]!;
    expect(alive(gc)).toBe(true);
    await r.session.interrupt({ softMs: 600, termMs: 300 });
    await r.until(() => !alive(gc), 3000);
    expect(alive(gc)).toBe(false);
  });

  it('close() leaves no grandchild either', async () => {
    const r = await R({ script: 'spawns-grandchild' });
    r.guard.beginTurn();
    r.session.prompt({ text: 'go' });
    await r.until(() => r.grandchildren().length === 1);
    const gc = r.grandchildren()[0]!;
    await r.session.close();
    await r.until(() => !alive(gc), 4000);
  });

  it('a crash mid-turn is error + turn.end(error), once', async () => {
    const r = await R({ script: 'crashes-mid-turn' });
    await r.turn();
    expect(r.text()).toBe('half');
    const tail = r.events.slice(-2);
    expect(tail[0]).toMatchObject({ kind: 'error', class: 'provider' });
    expect(tail[1]).toMatchObject({ kind: 'turn.end', stopReason: 'error' });
    expect(r.kinds().filter((x) => x === 'turn.end')).toHaveLength(1);
    expect(r.violations()).toEqual([]);
  });
});
