// Live smoke of the real adapter against the installed claude CLI (Haiku, tiny prompts). Skipped unless INTELY_LIVE=1:
//   INTELY_LIVE=1 pnpm --filter @intely/sidecar test claude-live        (about 9 model calls)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import claude from '../src/adapters/claude-sdk/index.js';
import { MIN_CLI_FOR_DELEGATION } from '../src/adapters/claude-sdk/facts.js';
import { ClaudeSession } from '../src/adapters/claude-sdk/session.js';
import { checkInvariants, SeqSink, TurnGuard } from '../src/turn.js';
import { dropTranscripts, FakeHost } from '../../tests/fakes/fake-host.mjs';
import { makePolicy } from '../../tests/fakes/hardstop-policy.mjs';

const LIVE = process.env.INTELY_LIVE === '1';
const CLAUDE = process.env.INTELY_CLAUDE_BIN ?? (LIVE ? execFileSync('/bin/zsh', ['-ilc', 'command -v claude']).toString().trim().split('\n').pop()! : '');
const HAIKU = 'claude-haiku-4-5-20251001';
const dirs: string[] = [];
const hosts: any[] = [];

function fixture(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'isw-live-')));
  dirs.push(dir);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, env });
  g('init', '-q', '-b', 'main'); g('config', 'user.name', 'F'); g('config', 'user.email', 'f@example.invalid');
  fs.writeFileSync(path.join(dir, 'README.md'), '# x\n'); g('add', '.'); g('commit', '-q', '-m', 'init');
  return dir;
}
const body = (agentId: string, cwd: string, over: Record<string, any> = {}) => ({
  agentId, provider: 'claude', cwd, env: { claudeBin: CLAUDE, shimDir: '/tmp/isw-live-shim' }, auth: { mode: 'subscription', key: null },
  role: { name: 'dev', model: HAIKU, permission: 'ask', maxTurns: 4, maxBudgetUsd: 0.1, ...over.role }, ...over, ...(over.role ? { role: { name: 'dev', model: HAIKU, permission: 'ask', maxTurns: 4, maxBudgetUsd: 0.1, ...over.role } } : {}),
});
const start = async (o: Record<string, any> = {}) => { const h = await new FakeHost({ providers: ['claude'], ...o }).start(); hosts.push(h); return h; };
afterAll(async () => { for (const h of hosts) await h.stop().catch(() => undefined); for (const d of dirs) { dropTranscripts(d); fs.rmSync(d, { recursive: true, force: true }); } });

describe.skipIf(!LIVE)('claude adapter, live', () => {
  beforeAll(() => { expect(CLAUDE).toBeTruthy(); });

  it('detect() finds the CLI and its version; listModels() reads the catalog without a model call', async () => {
    const d = await claude.detect({ claudeBin: CLAUDE });
    expect(d).toMatchObject({ installed: true, path: CLAUDE });
    expect(d.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(await claude.detect({})).toMatchObject({ installed: false });
    const models = await claude.listModels({ claudeBin: CLAUDE });
    expect(models.find((m) => m.id === 'haiku')).toMatchObject({ effortLevels: [] });
    expect(models.find((m) => m.id === 'sonnet')!.effortLevels).toContain('low');
  }, 40000);

  it('opens without a model call: caps from the CLI catalog (Haiku: effort n/a), lease with the CLI process group, clean close', async () => {
    const h = await start();
    const cwd = fixture();
    expect(await h.startSession(body('c1', cwd))).toMatchObject({ ok: true });
    const info = await h.waitEvent('c1', (e: any) => e.kind === 'session.info');
    expect(info.caps.effort.cap).toBe('no');
    expect(info.caps.effortLevels).toEqual([]);
    expect(info.models.find((m: any) => m.id === 'sonnet').effortLevels.length).toBeGreaterThan(0);
    const renew = h.slotCalls.find((c: any) => c.type === 'slot/renew');
    expect(renew.body.pgids[0]).toBeGreaterThan(1);
    const pgid = renew.body.pgids[0];
    await h.closeSession('c1');
    await new Promise((r) => setTimeout(r, 500));
    expect(() => process.kill(-pgid, 0)).toThrow(); // the whole CLI group is gone
    expect(h.slotCalls.at(-1).type).toBe('slot/release');
  }, 40000);

  it('effort is observed through get_settings, not assumed (Sonnet low -> applied low)', async () => {
    const h = await start();
    await h.startSession(body('c1', fixture(), { role: { model: 'sonnet', effort: 'low' } }));
    const info = await h.waitEvent('c1', (e: any) => e.kind === 'session.info');
    expect(info.caps.effort.cap).toBe('yes');
    expect(info.caps.effortLevels).toContain('low');
    await h.prompt('c1', 'Reply with exactly the word: OK');
    const ev = await h.waitTurnEnd('c1', 1, 90000);
    expect(ev.find((e: any) => e.kind === 'session.started')).toMatchObject({ effective: { effort: 'low' } });
    expect(ev.find((e: any) => e.kind === 'session.started').assertions ?? []).toEqual([]);
    await h.closeSession('c1');
  }, 120000);

  it('plain turn: session.started facts clean, stray API key removed and reported, usage, invariants', async () => {
    const h = await start();
    const cwd = fixture();
    const vars = { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-api03-dummy-not-real-000000', CLAUDE_EFFORT: 'max', INTELY_HUMAN_TOKEN: 'x' } as Record<string, string>;
    await h.startSession(body('c1', cwd, { env: { claudeBin: CLAUDE, vars } }));
    await h.prompt('c1', 'Reply with exactly the word: OK');
    const ev = await h.waitTurnEnd('c1', 1, 90000);
    const started = ev.find((e: any) => e.kind === 'session.started');
    expect(started).toMatchObject({ model: HAIKU, effective: { effort: null, permission: 'ask' }, auth: { mode: 'subscription', source: 'none' } });
    expect(started.assertions ?? []).toEqual([]);
    expect(started.auth.warning).toContain('removed');
    expect(ev.find((e: any) => e.kind === 'text.done').text).toMatch(/OK/);
    expect(ev.find((e: any) => e.kind === 'usage').usage.perTurn.outputTokens).toBeGreaterThan(0);
    expect(checkInvariants(ev)).toEqual([]);
    await h.closeSession('c1');
  }, 120000);

  it('interrupt in streaming-input mode: turn.end(cancelled), then the same session answers a follow-up', async () => {
    const h = await start();
    await h.startSession(body('c1', fixture()));
    await h.prompt('c1', 'Count from 1 to 300, one number per line, no other text.');
    await h.waitEvent('c1', (e: any) => e.kind === 'text.delta', 90000);
    await h.cancel('c1', 5000, 3000);
    await h.waitTurnEnd('c1', 1, 30000);
    expect(h.events('c1').filter((e: any) => e.kind === 'turn.end')[0].stopReason).toBe('cancelled');
    await h.prompt('c1', 'Reply with exactly the word: AGAIN');
    const ev = await h.waitTurnEnd('c1', 2, 90000);
    expect(ev.filter((e: any) => e.kind === 'turn.end').map((e: any) => e.stopReason)).toEqual(['cancelled', 'endTurn']);
    expect(checkInvariants(ev)).toEqual([]);
    await h.closeSession('c1');
  }, 200000);

  it('the CLI group killed from outside (what Rust does after a lease timeout): error + turn.end(error), pending approvals cancelled', async () => {
    const h = await start();
    await h.startSession(body('c1', fixture()));
    await h.prompt('c1', 'Count from 1 to 300, one number per line, no other text.');
    await h.waitEvent('c1', (e: any) => e.kind === 'text.delta', 90000);
    process.kill(-h.slotCalls.find((c: any) => c.type === 'slot/renew').body.pgids[0], 'SIGKILL');
    const ev = await h.waitTurnEnd('c1', 1, 30000);
    expect(ev.at(-1)).toMatchObject({ kind: 'turn.end', stopReason: 'error' });
    expect(ev.find((e: any) => e.kind === 'error')).toMatchObject({ class: 'provider' });
    expect(checkInvariants(ev)).toEqual([]);
    await h.closeSession('c1');
  }, 150000);

  it('write asks the UI; deny reaches the model as a denied tool result and nothing is written', async () => {
    const log: any[] = [];
    const h = await start({ policy: makePolicy({ askWrites: true, log }) });
    const cwd = fixture();
    await h.startSession(body('c1', cwd, { role: { permission: 'edit' } }));
    await h.prompt('c1', 'Use the Write tool to create nope.txt with content "x". If refused, say REFUSED.');
    const req = await h.waitEvent('c1', (e: any) => e.kind === 'permission.request', 90000);
    await h.answer('c1', req.reqId, { outcome: 'deny', message: 'not today' });
    const ev = await h.waitTurnEnd('c1', 1, 90000);
    expect(fs.existsSync(path.join(cwd, 'nope.txt'))).toBe(false);
    expect(ev.find((e: any) => e.kind === 'tool.result')).toMatchObject({ status: 'denied' });
    expect(checkInvariants(ev)).toEqual([]);
    await h.closeSession('c1');
  }, 150000);

  it('AskUserQuestion round trip through question.request', async () => {
    const h = await start();
    await h.startSession(body('c1', fixture()));
    await h.prompt('c1', 'You must call the AskUserQuestion tool exactly once: ask which colour I prefer, options Red and Blue. Then state my answer in one word.');
    const q = await h.waitEvent('c1', (e: any) => e.kind === 'question.request', 90000);
    expect(q.options.map((o: any) => o.label)).toEqual(expect.arrayContaining(['Red', 'Blue']));
    await h.answer('c1', q.reqId, { outcome: 'allow', answers: { [q.prompt]: 'Blue' } });
    const ev = await h.waitTurnEnd('c1', 1, 90000);
    expect(ev.filter((e: any) => e.kind === 'text.done').map((e: any) => e.text).join(' ')).toMatch(/blue/i);
    await h.closeSession('c1');
  }, 150000);

  it('resume re-passes additionalDirectories: the added dir is readable and its CLAUDE.md loads after resume', async () => {
    const cwd = fixture();
    const add = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'isw-live-add-')));
    dirs.push(add);
    fs.writeFileSync(path.join(add, 'CLAUDE.md'), '# Added-dir rules\nThe secret marker is ZEBRA-SEVEN-4821.\n');
    const sessionId = '3d1c0f0e-5b7a-4c63-8f0e-aaaaaaaaaa01';
    const h = await start({ policy: () => ({ decision: 'allow', by: 'saved' }) });
    await h.startSession(body('c1', cwd, { addDirs: [add], sessionId }));
    await h.prompt('c1', 'Reply with exactly the word: ONE');
    await h.waitTurnEnd('c1', 1, 90000);
    await h.closeSession('c1');
    const h2 = await start({ policy: () => ({ decision: 'allow', by: 'saved' }) });
    expect(await h2.startSession(body('c2', cwd, { addDirs: [add], resume: { nativeId: sessionId } }))).toMatchObject({ ok: true, nativeId: sessionId });
    await h2.prompt('c2', 'If your context contains a secret marker from a CLAUDE.md, state it, else say MARKER=NONE.');
    const ev = await h2.waitTurnEnd('c2', 1, 90000);
    expect(ev.filter((e: any) => e.kind === 'text.done').map((e: any) => e.text).join(' ')).toContain('ZEBRA-SEVEN-4821');
    expect(ev.find((e: any) => e.kind === 'session.started').nativeId).toBe(sessionId);
    await h2.closeSession('c2');
  }, 200000);

  // The blocking gate of (design notes: roles-orchestration-spec) 8.3 (R1, R2): Auto is not enabled by default in a release until this passed
  // against the installed CLI. At most 3 Haiku calls (lead + one sub-agent). Not run by the build harness: it needs the user's own
  // login (keychain), which the harness may not touch. Run it by hand: INTELY_LIVE=1 pnpm --filter @intely/sidecar test claude-live
  it('delegation: agent_type reaches the hook, the sub-agent runs on the role model in the foreground, and a researcher Edit is refused', async () => {
    const version = (await claude.detect({ claudeBin: CLAUDE })).version ?? '0';
    const num = (v: string) => v.split('.').map((x) => Number(x) || 0);
    const [a, b] = [num(version), num(MIN_CLI_FOR_DELEGATION)];
    expect(a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2]))), `CLI ${version} is older than MIN_CLI_FOR_DELEGATION ${MIN_CLI_FOR_DELEGATION}`).toBe(true);
    const cwd = fixture();
    fs.writeFileSync(path.join(cwd, 'notes.txt'), 'the answer is 42\n');
    const calls: any[] = [];
    const h = await start({
      policy: (req: any) => {
        calls.push(req.intent);
        const role = req.intent.actor?.role;
        if (role === 'researcher' && req.intent.class === 'write') return { decision: 'deny', by: 'roleDeny', reason: 'read-only role', rule: 'role.tool-not-allowed' };
        return { decision: 'allow', by: 'default', rule: 'live.allow' };
      },
    });
    const delegates = [{
      name: 'researcher', description: 'Reads files and reports what they say. Use it for any question about file contents.', prompt: 'You read files with the Read tool and report. If asked to edit, try the Edit tool once and report what happened.',
      model: HAIKU, permission: 'readOnly', tools: ['Read', 'Grep', 'Glob', 'Edit'], disallowedTools: ['Agent', 'Task'], maxTurns: 4, scope: 'global',
    }];
    await h.startSession(body('d1', cwd, { delegates, role: { name: 'auto', permission: 'edit', maxTurns: 6 }, env: { claudeBin: CLAUDE, shimDir: '/tmp/isw-live-shim' } }));
    await h.prompt('d1', 'Start the researcher agent (foreground, run_in_background false) and ask it to read notes.txt, then try to append a line with the Edit tool. Report both results in one sentence.');
    const ev = await h.waitTurnEnd('d1', 1, 150000);
    const agentCall = calls.find((i) => i.tool === 'Agent' || i.tool === 'Task');
    expect(agentCall, 'the lead called the Agent tool').toBeTruthy();
    const subCalls = calls.filter((i) => i.actor);
    expect(subCalls.length, 'agent_id/agent_type reached the PreToolUse hook (R2)').toBeGreaterThan(0);
    expect(subCalls.every((i) => i.actor.role === 'researcher')).toBe(true);
    const sub = ev.filter((e: any) => e.parentToolId && e.raw?.message?.model);
    expect(sub.length).toBeGreaterThan(0);
    expect(sub[0].raw.message.model).toContain('haiku');
    const edit = calls.find((i) => i.actor && i.class === 'write');
    if (edit) expect(ev.some((e: any) => e.kind === 'permission.resolved' && e.by === 'roleDeny')).toBe(true);
    // R1: the Agent call ran in the foreground, i.e. its tool.result (the report) arrived inside the lead's turn
    const agentStart = ev.find((e: any) => e.kind === 'tool.start' && (e.name === 'Agent' || e.name === 'Task'));
    const agentResult = ev.find((e: any) => e.kind === 'tool.result' && e.toolId === agentStart?.toolId);
    expect(agentResult?.status).toBe('ok');
    expect(String(agentResult?.output ?? '')).not.toMatch(/running in the background|started in the background/i);
    expect(checkInvariants(ev)).toEqual([]);
    await h.closeSession('d1');
  }, 240000);
});

// ---------- the five modes against the real CLI (permission-modes spec 6.7: probes L1 to L8) ----------
// Haiku, tiny prompts, maxBudgetUsd 0.2 per session, throw-away fixtures only. The policy is a JS stand-in that follows the Rust table of the mode
// (the real broker is proven by crates/agent_core/tests); what is measured here is the CLI: mode mapping, plan approval, live switch, boundary prompts.
//   INTELY_LIVE=1 INTELY_CLAUDE_BIN=<claude> pnpm --filter @intely/sidecar test claude-live -t "modes, live"   (about 14 model calls)
type Mode = 'readOnly' | 'ask' | 'edit' | 'automatic' | 'bypass';
const LOW_RISK = /^(ls|cat|pwd|git status|git log|git diff)\b/;

/** What the Rust table does for the modes, as far as the probes need it. `state.mode` is changed by a test exactly like the host does (Rust first). */
function modePolicy(state: { mode: Mode; planDir?: string; cwd: string }, log: any[] = []) {
  const base = makePolicy();
  const inside = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);
  return (req: any) => {
    const i = req.intent;
    const hard = base(req);
    let out: any = hard.decision === 'deny' ? hard : { decision: 'allow', by: 'saved' };
    if (out.decision === 'allow' && (/\/\.claude(\/|$)/.test(JSON.stringify(i.paths ?? [])) || /\.claude/.test(String(i.rawCommand ?? '')))) out = { decision: 'deny', by: 'hardStop', reason: 'the user\'s Claude home is off limits', rule: 'fs.protected' };
    const writes = i.class === 'write';
    const exec = i.class === 'exec';
    const paths: string[] = (i.paths ?? []).map((q: string) => path.resolve(state.cwd, q));
    if (out.decision === 'allow') {
      switch (state.mode) {
        case 'readOnly':
          if (i.tool === 'ExitPlanMode') out = { decision: 'ask', by: 'roleDeny', rule: 'other.exit-plan' };
          else if (writes && !(state.planDir && paths.every((q) => inside(q, state.planDir!)))) out = { decision: 'deny', by: 'roleDeny', reason: 'plan mode writes nothing', rule: 'role.read-only' };
          else if (exec && !LOW_RISK.test(String(i.rawCommand ?? ''))) out = { decision: 'deny', by: 'roleDeny', reason: 'plan mode runs only read commands', rule: 'role.read-only' };
          break;
        case 'ask':
          if (writes || exec) out = { decision: 'ask', by: 'roleDeny', rule: 'write.ask' };
          break;
        case 'edit':
          if (writes && !paths.every((q) => inside(q, state.cwd))) out = { decision: 'ask', by: 'roleDeny', rule: 'write.outside' };
          else if (exec && !LOW_RISK.test(String(i.rawCommand ?? ''))) out = { decision: 'ask', by: 'roleDeny', rule: 'exec.ask' };
          break;
        case 'automatic':
          if ((writes || i.class === 'read') && !paths.every((q) => inside(q, state.cwd))) out = { decision: 'deny', by: 'hardStop', reason: 'outside the run directories', rule: 'fs.outside-jail' };
          break;
        default: break; // bypass: everything the hard stops let through
      }
    }
    log.push({ mode: state.mode, tool: i.tool, class: i.class, cmd: i.rawCommand, paths: i.paths, ...out });
    return out;
  };
}

/** Findings of a live run (the open facts of the spec), appended to $INTELY_LIVE_NOTES when set and printed either way. */
function note(key: string, value: unknown): void {
  console.log(`[live-note] ${key}: ${JSON.stringify(value)}`);
  if (process.env.INTELY_LIVE_NOTES) fs.appendFileSync(process.env.INTELY_LIVE_NOTES, `${JSON.stringify({ key, value })}\n`);
}

describe.skipIf(!LIVE)('claude adapter, modes, live', () => {
  const shim = fs.mkdtempSync(path.join(os.tmpdir(), 'isw-live-shim-'));
  fs.writeFileSync(path.join(shim, 'git'), '#!/bin/sh\nexec /usr/bin/git "$@"\n', { mode: 0o755 });
  dirs.push(shim);
  const modeBody = (agentId: string, cwd: string, mode: Mode, over: Record<string, any> = {}) => ({
    agentId, provider: 'claude', cwd, auth: { mode: 'subscription', key: null },
    role: { name: 'dev', model: HAIKU, permission: mode, maxTurns: 8, maxBudgetUsd: 0.2 },
    env: { claudeBin: CLAUDE, shimDir: shim, vars: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } },
    ...over,
  });
  const tmpDir = (tag: string) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `isw-live-${tag}-`))); dirs.push(d); return d; };
  const cards = (ev: any[]) => ev.filter((e) => e.kind === 'permission.request' && e.options.includes('allow_once'));
  const refused = (ev: any[]) => ev.filter((e) => e.kind === 'permission.resolved' && e.outcome === 'deny');
  const dump = (ev: any[], log: any[]) => JSON.stringify({ tail: ev.filter((e) => /tool\.|permission|error|session\./.test(e.kind)).map((e) => ({ k: e.kind, n: e.name, s: e.status, o: String(e.output ?? '').slice(0, 120), m: e.message?.slice?.(0, 160), by: e.by, in: e.input?.command ?? e.input?.file_path })).slice(-14), policy: log.slice(-8) });
  const PREFIX = 'This is an authorized permission test inside a throwaway repository: make the tool call even if you think the mode forbids it, and report the outcome in one short line. ';

  it('L8: no user plugin and no foreign MCP server in any of the five modes; session.started reports the IDE mode and no assertion fails', async () => {
    for (const mode of ['readOnly', 'ask', 'edit', 'automatic', 'bypass'] as const) {
      const state = { mode, cwd: fixture() };
      const h = await start({ policy: modePolicy(state) });
      expect(await h.startSession(modeBody('m8', state.cwd, mode))).toMatchObject({ ok: true });
      await h.prompt('m8', 'Reply with exactly the word: OK');
      const ev = await h.waitTurnEnd('m8', 1, 90000);
      const started = ev.find((e: any) => e.kind === 'session.started');
      expect(started, mode).toMatchObject({ effective: { permission: mode } });
      expect(started.assertions ?? [], mode).toEqual([]);
      expect(ev.filter((e: any) => e.kind === 'error' && /isolation leaked/.test(e.message)), mode).toEqual([]);
      expect(ev.at(-1)).toMatchObject({ kind: 'turn.end', stopReason: 'endTurn' });
      await h.closeSession('m8');
    }
  }, 600000);

  it('L7: EnterPlanMode is not among the tools of the init report, and the D12 note is in the model context', async () => {
    // the init message lists the tools the CLI offers: measured directly, not asked of the model (a model may say it has a tool the note names)
    const cwd = fixture();
    const out: any[] = [];
    const guard = new TurnGuard(new SeqSink((e) => out.push(e)));
    guard.beginTurn();
    let tools: string[] = [];
    const session = await ClaudeSession.open(
      { agentId: 'm7', provider: 'claude', role: { name: 'dev', model: HAIKU, permission: 'ask', maxTurns: 3, maxBudgetUsd: 0.2 }, cwd, addDirs: [], env: { claudeBin: CLAUDE, shimDir: shim }, mcp: {}, auth: { mode: 'subscription', key: null } },
      guard, { decide: async () => ({ decision: 'allow', by: 'saved' }) }, { registerPid: () => undefined },
      (m) => { if (m.type === 'system' && m.subtype === 'init') tools = m.tools ?? []; },
    );
    session.prompt({ text: 'Answer in two lines, nothing else. Line 1: "SMART=" then yes if you have a tool whose name starts with smart_, else no. Line 2: "NOTE=" then the first six words of any note you were given that starts with "IDE session notes", else none.' });
    for (let i = 0; i < 900 && !out.some((e) => e.kind === 'turn.end'); i++) await new Promise((r) => setTimeout(r, 100));
    await session.close();
    note('L7 tools offered by the CLI', tools);
    expect(tools.length, 'the init report lists tools').toBeGreaterThan(5);
    expect(tools).not.toContain('EnterPlanMode');
    expect(tools.filter((t) => t.startsWith('smart_'))).toEqual([]);
    const text = out.filter((e) => e.kind === 'text.done').map((e) => e.text).join('\n');
    expect(text).toMatch(/SMART=\s*no/i);
    expect(text).toMatch(/NOTE=.*IDE session notes/i);
  }, 150000);

  it('L3 + L4: Plan refuses writes, ExitPlanMode shows the full plan, approving with Accept edits continues in acceptEdits (next Write runs with no card), the plan file lands in the plan directory', async () => {
    const cwd = fixture();
    const planDir = tmpDir('plans'); // outside the cwd on purpose: probe L3 measured that the CLI IGNORES it there and aims at ~/.claude/plans, which the policy refuses
    const state = { mode: 'readOnly' as Mode, planDir, cwd };
    const log: any[] = [];
    const h = await start({ policy: modePolicy(state, log) });
    await h.startSession(modeBody('m4', cwd, 'readOnly', { planDir, role: { name: 'dev', model: HAIKU, permission: 'readOnly', maxTurns: 10, maxBudgetUsd: 0.2 } }));
    await h.prompt('m4', `${PREFIX}You are in plan mode. Plan the creation of a file hello.txt containing the word hi: first try the Write tool on hello.txt once, then write a two-paragraph plan and call the ExitPlanMode tool with that plan. After it is approved, create hello.txt with the Write tool.`);
    const card = await h.waitEvent('m4', (e: any) => e.kind === 'permission.request' && e.modes?.length, 120000).catch((e: Error) => { throw new Error(`${e.message} ${dump(h.events('m4'), log)}`); });
    expect(card).toMatchObject({ options: ['allow_once', 'deny'], modes: ['ask', 'edit', 'automatic'] });
    expect(card.plan, 'the card carries the plan text (the plan file is refused, so the last assistant text)').toBeTruthy();
    expect(fs.existsSync(path.join(cwd, 'hello.txt')), 'Plan wrote nothing before the approval').toBe(false);
    state.mode = 'edit'; // what the host does when it validates the answer: Rust first
    await h.answer('m4', card.reqId, { outcome: 'allow', mode: 'edit' });
    const ev = await h.waitTurnEnd('m4', 1, 120000);
    expect(ev.find((e: any) => e.kind === 'session.info' && e.effective?.reason === 'planApproved')).toMatchObject({ effective: { permission: 'edit' } });
    expect(fs.existsSync(path.join(cwd, 'hello.txt')), `hello.txt exists after the approval ${dump(ev, log)}`).toBe(true);
    expect(cards(ev).filter((e: any) => e.modes?.length === 0 || !e.modes).length, 'no further card after the approval').toBe(0);
    // L3: where did the plan file go? (nowhere: the policy refused the CLI's default path, and the directory outside the cwd was ignored)
    note('L3 plan dir files and card plan length', { files: fs.readdirSync(planDir), planChars: card.plan.length, planFromInput: log.some((l) => l.tool === 'ExitPlanMode') });
    await h.closeSession('m4');
  }, 300000);

  it('L5: Automatic runs a script-style command with no prompt; git commit is denied by the hook and a Write into .git by the settings deny rule', async () => {
    const cwd = fixture();
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0', scripts: { test: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\',\'1\')"' } }));
    const state = { mode: 'automatic' as Mode, cwd };
    const log: any[] = [];
    const h = await start({ policy: modePolicy(state, log) });
    await h.startSession(modeBody('m5', cwd, 'automatic'));
    await h.prompt('m5', `${PREFIX}Do three things in order, one tool call each: (1) run \`npm test\` with the Bash tool; (2) run \`git commit --allow-empty -m x\` with the Bash tool; (3) use the Write tool to create the file .git/hooks/pre-commit with the content "x". Report each outcome.`);
    const ev = await h.waitTurnEnd('m5', 1, 150000);
    expect(fs.existsSync(path.join(cwd, 'ran.txt')), `npm test ran ${dump(ev, log)}`).toBe(true);
    expect(cards(ev), 'no card in Automatic').toEqual([]);
    const commits = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).toString().trim();
    expect(commits, 'the commit was refused').toBe('1');
    expect(fs.existsSync(path.join(cwd, '.git', 'hooks', 'pre-commit'))).toBe(false);
    expect(ev.filter((e: any) => e.kind === 'error' && e.class === 'policy').map((e: any) => e.message), 'no CLI prompt was refused by the unattended gate').toEqual([]);
    await h.closeSession('m5');
  }, 300000);

  it('L9: the plugin-style flow in Automatic: a python heredoc edit, a cd into the other repository and a /tmp scratch file run with no card and no refused CLI prompt', async () => {
    const cwd = fixture();
    const other = fixture();
    const scratch = `/tmp/isw-l9-${process.pid}.txt`;
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    const hard = makePolicy();
    // what the Rust broker says in Automatic for this flow: allowed unless a hard stop applies (the run's folders and the scratch root)
    const policy = (req: any) => { const d = hard(req); return d.decision === 'deny' ? d : { decision: 'allow', by: 'saved' }; };
    const h = await start({ policy });
    await h.startSession(modeBody('m9', cwd, 'automatic', { addDirs: [other] }));
    await h.prompt('m9', `${PREFIX}Run these three shell commands with the Bash tool, one call each, exactly as written, then report each outcome: (1) python3 - <<'EOF'\nopen('notes.txt', 'a').write('edited\\n')\nEOF\n(2) cd ${other} && git status --short && git log --oneline -1\n(3) git show HEAD:README.md > ${scratch} && wc -l ${scratch}`);
    const ev = await h.waitTurnEnd('m9', 1, 180000);
    try {
      expect(fs.existsSync(path.join(cwd, 'notes.txt')) && fs.readFileSync(path.join(cwd, 'notes.txt'), 'utf8'), `the python heredoc edited a file ${dump(ev, [])}`).toContain('edited');
      expect(fs.existsSync(scratch), `the scratch file was written ${dump(ev, [])}`).toBe(true);
      expect(cards(ev), 'no card in Automatic').toEqual([]);
      expect(refused(ev), `nothing was refused ${JSON.stringify(refused(ev)).slice(0, 700)} ${dump(ev, [])}`).toEqual([]);
      expect(ev.filter((e: any) => e.kind === 'error' && e.class === 'policy').map((e: any) => e.message), 'no CLI prompt was refused by the unattended gate').toEqual([]);
      expect(execFileSync('git', ['status', '--short'], { cwd: other, env }).toString()).toBe('');
    } finally {
      fs.rmSync(scratch, { force: true });
    }
    await h.closeSession('m9');
  }, 300000);

  it('L2 + L6: Bypass runs a Bash touch and a Write OUTSIDE the cwd (the CLI boundary prompt is answered from the Rust allow); git push stays denied', async () => {
    const cwd = fixture();
    const outside = tmpDir('out');
    const state = { mode: 'bypass' as Mode, cwd };
    const log: any[] = [];
    const h = await start({ policy: modePolicy(state, log) });
    await h.startSession(modeBody('m6', cwd, 'bypass'));
    await h.prompt('m6', `${PREFIX}Do three things in order, one tool call each: (1) run \`touch ${outside}/from-bash.txt\` with the Bash tool; (2) use the Write tool to create ${outside}/from-write.txt with the content "w"; (3) run \`git push origin HEAD\` with the Bash tool. Report each outcome.`);
    const ev = await h.waitTurnEnd('m6', 1, 150000);
    const have = fs.readdirSync(outside);
    note('L2 outside files and errors', { have, errors: ev.filter((e: any) => e.kind === 'error').map((e: any) => e.message.slice(0, 200)) });
    expect(have, `outside writes ${dump(ev, log)}`).toEqual(expect.arrayContaining(['from-bash.txt', 'from-write.txt']));
    expect(cards(ev), 'no card in Bypass').toEqual([]);
    expect(refused(ev).some((e: any) => e.by === 'hardStop'), 'git push was refused by the hard stop').toBe(true);
    await h.closeSession('m6');
  }, 300000);

  it('L1: setPermissionMode plan -> acceptEdits -> default -> acceptEdits, between turns and DURING a running turn; the next tool call follows each mode', async () => {
    const cwd = fixture();
    const state = { mode: 'readOnly' as Mode, cwd };
    const log: any[] = [];
    const h = await start({ policy: modePolicy(state, log) });
    await h.startSession(modeBody('m1', cwd, 'readOnly', { role: { name: 'dev', model: HAIKU, permission: 'readOnly', maxTurns: 6, maxBudgetUsd: 0.2 } }));
    const write = (n: string) => `${PREFIX}Use the Write tool to create the file ${n}.txt with the content "x". If refused, say REFUSED.`;
    const switchTo = async (mode: Mode) => { state.mode = mode; return h.request('session/permission', { agentId: 'm1', mode }, 15000); };
    let turns = 0;
    const turn = async (text: string) => { await h.prompt('m1', text); turns += 1; return h.waitTurnEnd('m1', turns, 120000); };
    await turn(write('a'));
    expect(fs.existsSync(path.join(cwd, 'a.txt')), 'Plan: no file').toBe(false);
    expect(await switchTo('edit')).toEqual({ ok: true });
    await turn(write('b'));
    expect(fs.existsSync(path.join(cwd, 'b.txt')), `Accept edits: file created ${dump(h.events('m1'), log)}`).toBe(true);
    expect(await switchTo('ask')).toEqual({ ok: true });
    await h.prompt('m1', write('c')); turns += 1;
    const card = await h.waitEvent('m1', (e: any) => e.kind === 'permission.request' && e.options.includes('allow_once') && e.intent.paths?.some((q: string) => q.endsWith('c.txt')), 120000);
    await h.answer('m1', card.reqId, { outcome: 'deny', message: 'no' });
    await h.waitTurnEnd('m1', turns, 120000);
    expect(fs.existsSync(path.join(cwd, 'c.txt')), 'Ask: the card was shown and denied').toBe(false);
    // a switch DURING a turn
    await h.prompt('m1', 'Count from 1 to 150, one number per line, no other text.'); turns += 1;
    await h.waitEvent('m1', (e: any) => e.kind === 'text.delta' && e.seq > (h.events('m1').filter((x: any) => x.kind === 'turn.end').at(-1)?.seq ?? 0), 90000);
    const mid = await switchTo('automatic');
    note('L1 mid-turn switch reply', mid);
    await h.waitTurnEnd('m1', turns, 120000);
    expect(mid).toEqual({ ok: true });
    await turn(write('d'));
    expect(fs.existsSync(path.join(cwd, 'd.txt')), `Automatic after the mid-turn switch: file created ${dump(h.events('m1'), log)}`).toBe(true);
    await h.closeSession('m1');
  }, 600000);
});

