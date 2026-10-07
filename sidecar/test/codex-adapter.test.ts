// Codex adapter against the fake app-server (providers-plan 5.7 / 6.2 5c): lifecycle, event mapping, approvals through the
// broker, cancel, schema drift, crash, open-time refusals and the env/argv hygiene. Fakes prove protocol handling, not vendor behaviour.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertSafeArgs, assertSafeParams, buildCodexEnv, clampEffort, policyFor, spawnArgs } from '../src/adapters/codex/config.js';
import provider from '../src/adapters/codex/index.js';
import { errorClassOf, mapNotification, newMapState } from '../src/adapters/codex/map.js';
import { RpcPeer } from '../src/adapters/codex/rpc.js';
import { Loader, ProviderDisabledError } from '../src/loader.js';
import { registry } from '../src/registry.js';
import { makePolicy } from '../../tests/fakes/hardstop-policy.mjs';
import { FAKE, allow, answers, fixture, invariantsOk, rig, type Rig, tmp, until } from './codex-rig.js';

const open: Rig[] = [];
const track = async (o: Parameters<typeof rig>[0]) => { const r = await rig(o); open.push(r); return r; };
afterEach(async () => { await Promise.all(open.splice(0).map((r) => r.cleanup())); });

const standIn = (log: unknown[] = []) => { const f = makePolicy({ log }); return (r: any) => f(r); };
const kinds = (r: Rig, k: string) => r.out.filter((e) => e.kind === k) as any[];

describe('lifecycle and event mapping', () => {
  it('starts a thread with an explicit profile + approval policy and no legacy sandbox fields', async () => {
    const r = await track({ scenario: 'text' });
    const start = r.log().find((l) => l.dir === 'in' && l.m.method === 'thread/start').m.params;
    expect(start).toMatchObject({ permissions: ':read-only', approvalPolicy: 'on-request', model: 'fake-luna', ephemeral: false });
    expect(start).not.toHaveProperty('sandbox');
    expect(start).not.toHaveProperty('sandboxPolicy');
    r.turn(); await r.done();
    const turnStart = r.log().find((l) => l.dir === 'in' && l.m.method === 'turn/start').m.params;
    expect(turnStart).toMatchObject({ permissions: ':read-only', approvalPolicy: 'on-request', model: 'fake-luna', effort: 'high', summary: 'concise', threadId: 'th-1' });
    expect(turnStart).not.toHaveProperty('sandboxPolicy');
    expect(r.s.nativeId).toBe('th-1');
  });

  it('session.started carries the effective facts, auth source and caps; the turn streams and ends once', async () => {
    const r = await track({ scenario: 'text' });
    r.turn(); await r.done();
    const started = kinds(r, 'session.started')[0];
    expect(started).toMatchObject({ nativeId: 'th-1', model: 'fake-luna', effective: { effort: 'high', permission: 'readOnly', sandbox: 'read-only' }, auth: { mode: 'subscription', source: 'chatgpt' } });
    expect(started.auth.warning).toBeUndefined();
    const info = kinds(r, 'session.info')[0];
    expect(info.caps.effortLevels).toEqual(['low', 'medium', 'high']);
    expect(info.models.map((m: any) => m.id)).toEqual(['fake-luna', 'fake-plain']); // hidden models are not offered
    expect(kinds(r, 'text.delta').map((e) => e.text).join('')).toBe('Hello from the fake codex.');
    expect(kinds(r, 'text.done')[0]).toMatchObject({ messageId: 'msg-1', text: 'Hello from the fake codex.' });
    expect(kinds(r, 'turn.end')).toHaveLength(1);
    expect(kinds(r, 'turn.end')[0].stopReason).toBe('endTurn');
    invariantsOk(r);
  });

  it('maps usage (tokens only, included in the plan) and registers the child process group', async () => {
    const r = await track({ scenario: 'text' });
    r.turn(); await r.done();
    const u = kinds(r, 'usage')[0].usage;
    expect(u).toMatchObject({ model: 'fake-luna', costBasis: 'included', contextSize: 200000, contextUsed: 110, perTurn: { inputTokens: 100, cacheRead: 40, outputTokens: 10, reasoningTokens: 5 }, cumulative: { inputTokens: 100 } });
    expect(u.perTurn.costUsd).toBeUndefined(); // unknown is never 0
    expect(r.pids).toHaveLength(1);
  });

  it('maps command, file and mcp items to tool pairs with the right status, kind and diff', async () => {
    const r = await track({ scenario: 'tools' });
    r.turn(); await r.done();
    const starts = Object.fromEntries(kinds(r, 'tool.start').map((e) => [e.toolId, e]));
    expect(starts['cmd-1']).toMatchObject({ name: 'shell', toolKind: 'search' }); // listFiles
    expect(starts['cmd-2']).toMatchObject({ toolKind: 'exec' });
    expect(starts['mcp-1']).toMatchObject({ name: 'mcp__srv__look', toolKind: 'mcp' });
    expect(starts['file-9']).toMatchObject({ name: 'apply_patch', toolKind: 'edit' });
    const res = Object.fromEntries(kinds(r, 'tool.result').map((e) => [e.toolId, e]));
    expect(res['cmd-1']).toMatchObject({ status: 'ok', output: 'a.txt\n', durationMs: 12 });
    expect(res['cmd-2'].status).toBe('error'); // exit code 1
    expect(res['mcp-1'].status).toBe('ok');
    expect(res['file-9']).toMatchObject({ status: 'ok', diff: { path: 'new.txt', old: null, new: 'hi\n' } });
    expect(kinds(r, 'tool.update')[0]).toMatchObject({ toolId: 'cmd-1', status: 'running' });
    expect(kinds(r, 'plan')[0].items).toEqual([{ content: 'look', status: 'completed' }, { content: 'edit', status: 'inProgress' }]);
    expect(r.out.find((e) => e.kind === 'tool.start')?.raw).toMatchObject({ method: 'item/started' });
    invariantsOk(r);
  });

  it('maps reasoning summaries to thinking.delta', async () => {
    const r = await track({ scenario: 'reasoning' });
    r.turn(); await r.done();
    expect(kinds(r, 'thinking.delta').map((e) => e.text).join('')).toBe('Thinking about the task.');
    invariantsOk(r);
  });

  it('retry notices become a retrying status, a rate limit becomes throttled with a reset time', async () => {
    let r = await track({ scenario: 'retry-then-ok' });
    r.turn(); await r.done();
    expect(kinds(r, 'status').map((e) => e.state)).toContain('retrying');
    expect(kinds(r, 'error')).toHaveLength(0);
    r = await track({ scenario: 'rate-limited' });
    r.turn(); await r.done();
    const t = kinds(r, 'status').find((e) => e.state === 'throttled');
    expect(t.scope).toBe('rate_limit_reached');
    expect(t.retryAfterMs).toBeGreaterThan(0);
  });

  it('a failed turn reports the auth error (redacted) and ends with stopReason error', async () => {
    const r = await track({ scenario: 'error-turn' });
    r.turn(); await r.done();
    const e = kinds(r, 'error');
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ class: 'auth', retryable: false });
    expect(e[0].message).not.toContain('sk-abcdefghijklmnop');
    expect(kinds(r, 'turn.end')[0].stopReason).toBe('error');
    invariantsOk(r);
  });

  it('ignores notifications of other threads', async () => {
    const r = await track({ scenario: 'other-thread' });
    r.turn(); await r.done();
    expect(kinds(r, 'text.delta').map((e) => e.messageId)).not.toContain('m-other');
  });

  it('resumes the given thread id', async () => {
    const r = await track({ scenario: 'text', resume: 'th-1' });
    expect(r.log().some((l) => l.dir === 'in' && l.m.method === 'thread/resume' && l.m.params.threadId === 'th-1')).toBe(true);
  });
});

describe('model and effort (clamped, never silently different)', () => {
  it('clamps an effort the model does not offer and says so', async () => {
    const r = await track({ effort: 'xhigh' });
    const s = kinds(r, 'session.started')[0];
    expect(s.effective.effort).toBe('high');
    expect(s.assertions).toContain('effort: role asks "xhigh", applied "high"');
  });

  it('a model without effort levels shows n/a and sends no effort', async () => {
    const r = await track({ model: 'fake-plain', effort: 'high' });
    expect(kinds(r, 'session.info')[0].caps.effort.cap).toBe('no');
    expect(kinds(r, 'session.started')[0].assertions.join('|')).toContain('applied none');
    r.turn(); await r.done();
    expect(r.log().find((l) => l.dir === 'in' && l.m.method === 'turn/start').m.params).not.toHaveProperty('effort');
  });

  it('flags a model Codex does not offer', async () => {
    const r = await track({ model: 'gpt-nope' });
    expect(kinds(r, 'session.started')[0].assertions.join('|')).toContain('does not offer');
  });

  it('model/list failing is an assertion, not a failure', async () => {
    const r = await track({ scenario: 'models-fail' });
    expect(kinds(r, 'session.started')[0].assertions.join('|')).toContain('model/list failed');
  });

  it('clampEffort walks down the ladder', () => {
    expect(clampEffort('max', ['low', 'medium', 'high'])).toEqual({ level: 'high', clamped: true });
    expect(clampEffort('low', ['medium', 'high'])).toEqual({ level: 'medium', clamped: true });
    expect(clampEffort('high', ['low', 'high'])).toEqual({ level: 'high', clamped: false });
    expect(clampEffort('high', [])).toEqual({ level: null, clamped: true });
    expect(clampEffort(null, ['low'])).toEqual({ level: null, clamped: false });
  });
});

describe('approvals go through the broker (never acceptForSession)', () => {
  it('git commit is declined by the hard stop, never runs, and the Inspector sees who refused', async () => {
    const f = fixture();
    try {
      const before = f.refs();
      const r = await track({ scenario: 'approve-command', mode: 'edit', cwd: f.repo, shimDir: f.shim, policy: standIn(), env: { FAKE_CODEX_COMMAND: '/bin/zsh -lc "git commit --allow-empty -m x"' } });
      r.turn(); await r.done();
      expect(answers(r)[0]).toEqual({ decision: 'decline' });
      expect(r.asked[0].intent).toMatchObject({ class: 'exec', tool: 'shell', rawCommand: '/bin/zsh -lc "git commit --allow-empty -m x"' });
      expect(kinds(r, 'permission.request')[0]).toMatchObject({ toolId: 'cmd-1', options: ['deny'] });
      expect(kinds(r, 'permission.resolved')[0]).toMatchObject({ outcome: 'deny', by: 'hardStop' });
      expect(kinds(r, 'tool.result')[0].status).toBe('denied');
      expect(f.refs()).toBe(before);
      invariantsOk(r);
    } finally { f.cleanup(); }
  });

  it('an allowed command is accepted once and runs; the answer is the plain "accept"', async () => {
    const f = fixture();
    try {
      const r = await track({ scenario: 'approve-command', mode: 'edit', cwd: f.repo, shimDir: f.shim, env: { FAKE_CODEX_COMMAND: 'echo ran > ran.txt', FAKE_CODEX_OFFER: 'session' } });
      r.turn(); await r.done();
      expect(answers(r)[0]).toEqual({ decision: 'accept' }); // not acceptForSession, no execpolicy amendment
      expect(fs.readFileSync(path.join(f.repo, 'ran.txt'), 'utf8')).toBe('ran\n');
      expect(kinds(r, 'permission.request')).toHaveLength(0); // allow = no UI
      expect(kinds(r, 'tool.result')[0].status).toBe('ok');
    } finally { f.cleanup(); }
  });

  it('bait: when only a session-wide decision is offered the command is declined even though the broker allows it', async () => {
    const f = fixture();
    try {
      const r = await track({ scenario: 'approve-command', mode: 'edit', cwd: f.repo, shimDir: f.shim, env: { FAKE_CODEX_COMMAND: 'echo ran > ran.txt', FAKE_CODEX_OFFER: 'session-only' } });
      r.turn(); await r.done();
      expect(answers(r)[0]).toEqual({ decision: 'decline' });
      expect(fs.existsSync(path.join(f.repo, 'ran.txt'))).toBe(false);
      expect(kinds(r, 'permission.resolved')[0]).toMatchObject({ outcome: 'deny', by: 'default' });
    } finally { f.cleanup(); }
  });

  it('ask: the user answers allow_once -> accept, deny -> decline; policy sees the request first', async () => {
    const f = fixture();
    try {
      for (const [outcome, want, ran] of [['allow', 'accept', true], ['deny', 'decline', false]] as const) {
        const file = `ask-${outcome}.txt`;
        const r = await track({ scenario: 'approve-command', mode: 'ask', cwd: f.repo, shimDir: f.shim, policy: () => ({ decision: 'ask', by: 'default', reason: 'ask' }), env: { FAKE_CODEX_COMMAND: `echo x > ${file}`, FAKE_CODEX_OFFER: 'session' } });
        r.turn();
        const req = await until(() => kinds(r, 'permission.request')[0]);
        expect(req.options).toEqual(['allow_once', 'deny']);
        r.s.answer(req.reqId, { outcome });
        await r.done();
        expect(answers(r)[0]).toEqual({ decision: want });
        expect(fs.existsSync(path.join(f.repo, file))).toBe(ran);
        expect(kinds(r, 'permission.resolved')[0]).toMatchObject({ outcome, by: 'user' });
        invariantsOk(r);
      }
    } finally { f.cleanup(); }
  });

  it('fail closed: a throwing, garbled or empty policy declines', async () => {
    for (const policy of [() => { throw new Error('boom'); }, () => ({ nope: 1 }) as never, () => null as never]) {
      const r = await track({ scenario: 'approve-command', mode: 'edit', policy, env: { FAKE_CODEX_COMMAND: 'echo x' } });
      r.turn(); await r.done();
      expect(answers(r)[0]).toEqual({ decision: 'decline' });
      expect(kinds(r, 'permission.resolved')[0]).toMatchObject({ by: 'failClosed' });
    }
  });

  it('a file change: protected paths are declined, a normal path is accepted and written, grantRoot is always declined', async () => {
    const f = fixture();
    try {
      const p = standIn();
      let r = await track({ scenario: 'approve-file', mode: 'edit', cwd: f.repo, shimDir: f.shim, policy: p, env: { FAKE_CODEX_PATH: '.git/hooks/pre-commit' } });
      r.turn(); await r.done();
      expect(answers(r)[0]).toEqual({ decision: 'decline' });
      expect(r.asked[0].intent).toMatchObject({ class: 'write', paths: [path.join(f.repo, '.git/hooks/pre-commit')] });
      expect(fs.existsSync(path.join(f.repo, '.git/hooks/pre-commit'))).toBe(false);

      r = await track({ scenario: 'approve-file', mode: 'edit', cwd: f.repo, shimDir: f.shim, policy: p, env: { FAKE_CODEX_PATH: 'src/out.txt' } });
      r.turn(); await r.done();
      expect(answers(r)[0]).toEqual({ decision: 'accept' });
      expect(fs.readFileSync(path.join(f.repo, 'src/out.txt'), 'utf8')).toBe('content\n');

      r = await track({ scenario: 'grant-root', mode: 'edit', cwd: f.repo, shimDir: f.shim, policy: allow });
      r.turn(); await r.done();
      expect(answers(r)[0]).toEqual({ decision: 'decline' });
      expect(r.asked).toHaveLength(0); // a standing grant is not a question for the broker
      expect(fs.existsSync(path.join(f.repo, 'out.txt'))).toBe(false);
    } finally { f.cleanup(); }
  });

  it('network approvals reach the broker as a net intent', async () => {
    const r = await track({ scenario: 'approve-network', mode: 'edit', policy: () => ({ decision: 'deny', by: 'roleDeny', reason: 'no net' }) });
    r.turn(); await r.done();
    expect(r.asked[0].intent).toMatchObject({ class: 'net', url: 'https://example.com' });
    expect(answers(r)[0]).toEqual({ decision: 'decline' });
  });

  it('extra permissions and permission grants are never granted', async () => {
    const r = await track({ scenario: 'extra-permissions', mode: 'edit', policy: allow });
    r.turn(); await r.done();
    expect(answers(r)).toEqual([{ decision: 'decline' }, { permissions: {} }]);
    expect(r.asked).toHaveLength(0);
  });

  it('the legacy execCommandApproval is judged on argv', async () => {
    const r = await track({ scenario: 'legacy-exec', mode: 'edit', policy: allow });
    r.turn(); await r.done();
    expect(r.asked[0].intent).toMatchObject({ class: 'exec', argv: ['git', 'push', 'origin', 'HEAD'] });
    expect(answers(r)[0]).toEqual({ decision: 'approved' }); // plain approval, never approved_for_session
  });

  it('questions become question.request cards; secret questions are never asked', async () => {
    const r = await track({ scenario: 'user-input', mode: 'edit' });
    r.turn();
    const q = await until(() => kinds(r, 'question.request')[0]);
    expect(q).toMatchObject({ prompt: 'Pick one', options: [{ label: 'red' }, { label: 'blue' }] });
    r.s.answer(q.reqId, { outcome: 'allow', answers: { 'Pick one': 'blue' } });
    await r.done();
    expect(answers(r)[0]).toEqual({ answers: { q1: { answers: ['blue'] } } });
    expect(kinds(r, 'question.request')).toHaveLength(1);
  });

  it('server requests it does not know are answered (error / decline), so a turn never hangs', async () => {
    const r = await track({ scenario: 'unknown-requests', mode: 'edit' });
    r.turn(); await r.done();
    const note = r.log().find((l) => l.dir === 'note' && l.m.unknownRequestAnswers)?.m.unknownRequestAnswers;
    expect(note[0].error.code).toBe(-32601);
    expect(note[1].result).toEqual({ action: 'decline' });
    expect(note[2].result.success).toBe(false);
  });
});

describe('cancel protocol', () => {
  it('interrupt sends turn/interrupt, the turn ends cancelled and the open tool gets a cancelled result', async () => {
    const r = await track({ scenario: 'hang-until-interrupt' });
    r.turn();
    await until(() => kinds(r, 'tool.start').length === 1);
    await r.s.interrupt();
    await r.done();
    const i = r.log().find((l) => l.dir === 'in' && l.m.method === 'turn/interrupt').m.params;
    expect(i).toEqual({ threadId: 'th-1', turnId: 'turn-1' });
    expect(kinds(r, 'turn.end')[0].stopReason).toBe('cancelled');
    expect(kinds(r, 'tool.result')[0].status).toBe('cancelled');
    invariantsOk(r);
  });

  it('a pending approval resolves cancelled and the server is answered "cancel"', async () => {
    const r = await track({ scenario: 'approval-then-interrupt', mode: 'ask', policy: () => ({ decision: 'ask', by: 'default' }), env: { FAKE_CODEX_COMMAND: 'echo x' } });
    r.turn();
    await until(() => kinds(r, 'permission.request').length === 1);
    await r.s.interrupt();
    await r.done();
    expect(answers(r)[0]).toEqual({ decision: 'cancel' });
    expect(kinds(r, 'permission.resolved')[0].outcome).toBe('cancelled');
    invariantsOk(r);
  });

  it('an app-server that ignores the interrupt is escalated by the host: interrupt() returns, close() kills the group', async () => {
    const r = await track({ scenario: 'interrupt-ignored' });
    r.turn();
    await until(() => kinds(r, 'tool.start').length === 1);
    await r.s.interrupt(); // returns although the turn goes on
    expect(r.ended()).toBe(0);
    r.guard.endTurn('cancelled'); // what SidecarHost does after softMs
    expect(kinds(r, 'turn.end')[0].stopReason).toBe('cancelled');
    const pid = r.pids[0];
    await r.s.close();
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  });
});

describe('schema drift and crashes', () => {
  it('malformed and unknown messages never break the turn; drift is reported once', async () => {
    const r = await track({ scenario: 'drift' });
    r.turn(); await r.done();
    expect(kinds(r, 'text.done').map((e) => e.text)).toContain('survived drift');
    const errs = kinds(r, 'error').filter((e) => e.class === 'protocol');
    expect(errs.map((e) => e.message).filter((m) => m.includes('item/agentMessage/delta'))).toHaveLength(1);
    expect(kinds(r, 'turn.end')).toHaveLength(1);
    invariantsOk(r);
  });

  it('a crash mid-turn: redacted error, exactly one turn.end(error), session closes cleanly', async () => {
    const r = await track({ scenario: 'crash' });
    r.turn(); await r.done();
    const e = kinds(r, 'error')[0];
    expect(e.class).toBe('provider');
    expect(e.message).toContain('simulated crash');
    expect(e.message).not.toContain('sk-abcdefghijklmnop');
    expect(kinds(r, 'turn.end')[0].stopReason).toBe('error');
    invariantsOk(r);
  });

  it('thread/start without a thread id (drift) fails the open', async () => {
    await expect(rig({ scenario: 'drift-start' })).rejects.toThrow(/no thread id/);
  });

  it('a CLI that never answers initialize fails the open within the timeout', async () => {
    await expect(rig({ scenario: 'spawn-hang', open: { requestTimeoutMs: 300 } })).rejects.toThrow(/timeout: initialize|did not start/);
  });

  it('RpcPeer: garbage is counted, unknown server requests get an error, close fails pending requests', async () => {
    const wrote: any[] = [];
    const p = new RpcPeer({ write: (l) => wrote.push(JSON.parse(l)) });
    p.feed('not json'); p.feed('[1]'); p.feed('{"id":null}');
    expect(p.garbage).toBe(3);
    p.feed('{"id":7,"method":"x/y","params":{}}');
    await until(() => wrote.length === 1);
    expect(wrote[0]).toMatchObject({ id: 7, error: { code: -32601 } });
    const pending = p.request('a/b', {}, 5000);
    p.close(new Error('gone'));
    await expect(pending).rejects.toThrow('gone');
    await expect(p.request('c')).rejects.toThrow('gone');
  });

  it('error classes follow codexErrorInfo', () => {
    expect(errorClassOf('unauthorized')).toEqual({ class: 'auth', retryable: false });
    expect(errorClassOf('usageLimitExceeded').class).toBe('rate');
    expect(errorClassOf({ httpConnectionFailed: { httpStatusCode: 500 } })).toEqual({ class: 'network', retryable: true });
    expect(errorClassOf({ weird: 1 }).class).toBe('provider');
    expect(errorClassOf(undefined).class).toBe('provider');
  });

  it('mapNotification: a completed tool without a start still yields a pair; unknown methods yield nothing', () => {
    const st = newMapState({ cwd: '/r' });
    const out = mapNotification(st, 'item/completed', { item: { type: 'commandExecution', id: 'c9', command: 'ls', status: 'completed', exitCode: 0, commandActions: [] } });
    expect(out.map((e) => e.kind)).toEqual(['tool.start', 'tool.result']);
    expect(mapNotification(st, 'thread/status/changed', {})).toEqual([]);
  });
});

describe('open-time refusals (fail closed before anything runs)', () => {
  it('refuses a permission the IDE never offers', () => {
    expect(() => policyFor('automatic')).toThrow(/not offered/);
    expect(() => policyFor('bypass')).toThrow(/not offered/);
    expect(policyFor('readOnly')).toMatchObject({ profile: ':read-only', approval: 'on-request' });
    expect(policyFor('edit')).toMatchObject({ profile: ':workspace', approval: 'on-request' });
    expect(policyFor('ask')).toMatchObject({ profile: ':workspace', approval: 'untrusted' });
  });

  it('assertSafeParams rejects every way of widening the sandbox or skipping approvals', () => {
    for (const bad of [{ sandbox: 'danger-full-access' }, { sandbox: 'workspace-write' }, { sandboxPolicy: { type: 'dangerFullAccess' } }, { permissions: ':danger-full-access' }, { permissions: 'custom' },
      { approvalPolicy: 'never' }, { approvalPolicy: { granular: { rules: true } } }, { approvalsReviewer: 'auto_review' }, { dangerouslyBypassApprovalsAndSandbox: true }]) {
      expect(() => assertSafeParams(bad), JSON.stringify(bad)).toThrow(/refused unsafe/);
    }
    expect(() => assertSafeParams({ permissions: ':workspace', approvalPolicy: 'on-request', approvalsReviewer: 'user' })).not.toThrow();
  });

  it('assertSafeArgs rejects the bypass flags and sandbox widening through -c', () => {
    for (const bad of [['--dangerously-bypass-approvals-and-sandbox'], ['--yolo'], ['--full-auto'], ['-s', 'danger-full-access'], ['--sandbox', 'workspace-write'], ['--add-dir', '/'], ['-c', 'sandbox_mode="danger-full-access"'], ['-c', 'approval_policy="never"'], ['-c', 'default_permissions=":danger-full-access"'], ['-a', 'never']]) {
      expect(() => assertSafeArgs(bad), bad.join(' ')).toThrow(/refused unsafe/);
    }
    expect(() => assertSafeArgs(spawnArgs())).not.toThrow();
    expect(() => assertSafeArgs(['-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="read-only"'])).not.toThrow();
  });

  it('writing roles are refused without the opt-in, with INTELY_READONLY, or without the git shim', async () => {
    await expect(rig({ mode: 'edit', open: { allowWriter: false } })).rejects.toThrow(/read-only roles only/);
    await expect(rig({ mode: 'edit', vars: { INTELY_READONLY: '1' } })).rejects.toThrow(/INTELY_READONLY/);
    await expect(rig({ mode: 'edit', shimDir: null })).rejects.toThrow(/shimDir is required/);
    await expect(rig({ mode: 'automatic' as never })).rejects.toThrow(/not offered/);
    await expect(rig({ mode: 'bypass' as never })).rejects.toThrow(/not offered/);
  });

  it('refuses a session that Codex runs with another profile, approval policy or network access, and kills it', async () => {
    await expect(rig({ scenario: 'wrong-profile' })).rejects.toThrow(/permission profile/);
    await expect(rig({ scenario: 'wrong-approval' })).rejects.toThrow(/approval policy/);
    await expect(rig({ mode: 'edit', scenario: 'network-on' })).rejects.toThrow(/network access/);
  });

  it('not logged in: a clear message, no login is started; API-key mode is refused with the spike reason', async () => {
    await expect(rig({ scenario: 'logged-out' })).rejects.toThrow(/not logged in.*codex login/);
    await expect(rig({ auth: { mode: 'apiKey', key: 'sk-test-0000000000000000' } })).rejects.toThrow(/not supported yet/);
  });

  it('a CLI older than the supported version is refused', async () => {
    await expect(rig({ scenario: 'old-version' })).rejects.toThrow(/older than/);
  });

  it('a non-ChatGPT account in a subscription session carries an auth warning', async () => {
    const r = await track({ scenario: 'api-key-account' });
    expect(kinds(r, 'session.started')[0].auth.warning).toContain('API billing');
  });
});

describe('environment and argv hygiene', () => {
  it('the child gets an allow-listed environment with the shim first; stray keys are dropped and reported', async () => {
    const shim = tmp('shim');
    const r = await track({ mode: 'edit', shimDir: shim, vars: { OPENAI_API_KEY: 'sk-proj-aaaaaaaaaaaaaaaaaaaaaaaa', ANTHROPIC_API_KEY: 'sk-ant-aaaaaaaaaaaaaaaa', GH_TOKEN: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaa', SSH_AUTH_SOCK: '/tmp/x', INTELY_E2E: '1', DATABASE_URL: 'postgres://u:p@h/db' } });
    const note = r.log().find((l) => l.dir === 'note' && l.m.envKeys).m;
    for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GH_TOKEN', 'SSH_AUTH_SOCK', 'INTELY_E2E', 'DATABASE_URL', 'CODEX_API_KEY']) expect(note.envKeys, k).not.toContain(k);
    expect(note.path.split(':')[0]).toBe(shim);
    expect(kinds(r, 'session.started')[0].auth.warning).toContain('OPENAI_API_KEY');
  });

  it('buildCodexEnv reports names only', () => {
    const b = buildCodexEnv({ vars: { PATH: '/bin', HOME: '/h', FOO_SECRET: 'x', LC_ALL: 'C', CODEX_HOME: '/c' } }, { mode: 'subscription', key: null });
    expect(Object.keys(b.env).sort()).toEqual(['CODEX_HOME', 'HOME', 'LC_ALL', 'PATH']);
    expect(b.scrubbed).toEqual(['FOO_SECRET']);
  });

  it('spawn args neutralize the user config, disable only features the CLI lists, and never carry a bypass flag', async () => {
    const r = await track({ scenario: 'unknown-feature' }); // the fake aborts on an unknown --disable, like the real CLI
    const argv: string[] = r.log().find((l) => l.dir === 'note' && l.m.argv).m.argv;
    expect(argv.slice(0, 3)).toEqual(['app-server', '--listen', 'stdio://']);
    const disabled = argv.flatMap((a, i) => (a === '--disable' ? [argv[i + 1]] : []));
    expect(disabled).toEqual(['apps', 'browser_use', 'computer_use', 'plugins', 'hooks', 'multi_agent', 'goals', 'memories']);
    expect(argv).toContain('notify=[]');
    expect(argv).toContain('mcp_servers={}');
    expect(argv.join(' ')).not.toMatch(/dangerously|yolo|danger-full-access|never/);
  });

  it('when `features list` fails nothing is disabled and the run card says so', async () => {
    const r = await track({ scenario: 'features-fail' });
    const argv: string[] = r.log().find((l) => l.dir === 'note' && l.m.argv).m.argv;
    expect(argv).not.toContain('--disable');
    expect(kinds(r, 'session.started')[0].assertions.join('|')).toContain('features list');
  });
});

describe('detect and registry', () => {
  it('detect: installed + version + stored login, from the CLI only', async () => {
    const ok = await provider.detect({ codexBin: FAKE } as never);
    expect(ok).toMatchObject({ installed: true, version: '0.146.0', versionOk: true, auth: 'ok', path: FAKE });
    const missing = await provider.detect({ codexBin: path.join(path.dirname(FAKE), 'nope') } as never);
    expect(missing.installed).toBe(false);
  });

  it('the loader never imports the codex adapter unless it is enabled and a session opens', async () => {
    const l = new Loader(registry, ['claude']);
    await expect(l.load('codex')).rejects.toBeInstanceOf(ProviderDisabledError);
    expect(l.loaded()).toEqual([]);
    expect(Object.keys(registry)).toContain('codex');
  });

  it('static caps are honest: no hooks, no subagents, sandbox only partial', () => {
    const c = provider.capabilities({});
    expect([c.hooks.cap, c.subagents.cap, c.sandbox.cap, c.cancel.cap, c.permissions.cap]).toEqual(['no', 'no', 'partial', 'yes', 'yes']);
  });
});
