#!/usr/bin/env node
// 5-minute live smoke for an ACP agent through the real sidecar bundle (providers-plan 6.2). Runs ONLY in a throw-away fixture repo
// under the OS temp directory, as a readOnly role, with the Phase 0 text-pattern policy standing in for policy.rs. Sends 3 tiny prompts
// to the agent's own account; no credential is read or passed (an API key, if you want one, goes in the agent's own environment).
//
//   pnpm --filter @intely/sidecar build                       # once, so dist/index.js knows the acp/gemini providers
//   node sidecar/tests/live/acp-smoke.mjs gemini              # the Gemini CLI profile (gemini --acp)
//   node sidecar/tests/live/acp-smoke.mjs acp --cmd /path/to/agent --arg --acp
//   add --sidecar <bundle> to use another bundle, --keep to keep the fixture, --skip-cancel / --skip-bait to run fewer prompts
// Exit 0 = every check passed. Paste the printed table into (design notes: providers-plan) "ACP spike results".
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { makePolicy } from '../../../tests/fakes/hardstop-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const argv = process.argv.slice(2);
const provider = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'gemini';
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const flags = (n) => argv.flatMap((a, i) => (a === n ? [argv[i + 1]] : []));
const sidecar = flag('--sidecar') ?? path.join(ROOT, 'sidecar/dist/index.js');
if (!fs.existsSync(sidecar)) { console.error(`no sidecar bundle at ${sidecar}; run: pnpm --filter @intely/sidecar build`); process.exit(2); }

// Fixture: never a user repo.
const GIT = ['/usr/bin/git', '/usr/local/bin/git'].find((p) => fs.existsSync(p));
const GENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'intely-acp-smoke-')));
const repo = path.join(root, 'work');
const g = (...a) => execFileSync(GIT, a, { cwd: repo, env: GENV, encoding: 'utf8' }).trim();
fs.mkdirSync(repo);
g('init', '-q', '-b', 'main'); g('config', 'user.email', 'smoke@example.invalid'); g('config', 'user.name', 'smoke');
fs.writeFileSync(path.join(repo, 'README.md'), 'SMOKE-FIRST-LINE\nsecond line\n');
g('add', '.'); g('commit', '-q', '-m', 'init');
const head0 = g('rev-parse', 'HEAD');

const log = [];
const policy = makePolicy({ log });
const child = spawn('node', [sidecar, `--providers=${provider}`], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
const send = (id, type, body) => child.stdin.write(`${JSON.stringify({ v: 1, id, type, body })}\n`);
const events = [];
const replies = new Map();
const cancelDone = [];
readline.createInterface({ input: child.stdout }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.type === 'slot/acquire') send(m.id, 'reply', { leaseId: 'L1', ttlMs: 15000 });
  else if (m.type === 'slot/renew' || m.type === 'slot/release') send(m.id, 'reply', { ok: true });
  else if (m.type === 'policy/decide') send(m.id, 'reply', policy(m.body));
  else if (m.type === 'events/batch') events.push(...m.body.events);
  else if (m.type === 'cancel/done') cancelDone.push(m.body);
  else if (m.type === 'reply') replies.set(m.id, m.body);
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms, what) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await wait(50); } };
const ended = () => events.filter((e) => e.kind === 'turn.end').length;
const results = [];
const check = (name, ok, note = '') => { results.push({ name, ok, note }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? `  (${note})` : ''}`); };

let nextId = 10;
async function prompt(text, ms = 120_000) {
  const before = ended();
  const id = nextId++;
  send(id, 'session/prompt', { agentId: 'a1', text });
  await until(() => replies.has(id), 5000, 'prompt ack');
  await until(() => ended() > before, ms, `turn.end for "${text.slice(0, 30)}"`);
}

try {
  const start = { agentId: 'a1', provider, role: { name: 'smoke', model: 'default', permission: 'readOnly' }, cwd: repo, env: {}, mcp: {}, auth: { mode: 'subscription', key: null }, ...(flag('--cmd') ? { acp: { command: flag('--cmd'), args: flags('--arg') } } : {}) };
  send(1, 'session/start', start);
  await until(() => replies.has(1), 60_000, 'session/start');
  const r1 = replies.get(1);
  check('1 session opens (initialize + session/new, no login prompt)', !!r1.ok, r1.ok ? `nativeId ${r1.nativeId}` : `${r1.error}: ${r1.detail}`);
  if (!r1.ok) throw new Error('cannot continue');
  await wait(300); // the events of the start arrive in the next batch
  const info = events.find((e) => e.kind === 'session.info' && e.caps);
  const started = events.find((e) => e.kind === 'session.started');
  check('2 caps computed from initialize + config options', !!info, info ? `effort ${info.caps.effort.cap} [${info.caps.effortLevels}], models ${info.models?.length ?? 0}, resume ${info.caps.resume.cap}, attachments ${info.caps.attachments}` : '');
  console.log(`      assertions: ${JSON.stringify(started?.assertions ?? [])}; effective: ${JSON.stringify(started?.effective)}`);

  await prompt('Reply with exactly the first line of README.md, and nothing else.');
  const t1 = events.filter((e) => e.kind === 'text.delta').map((e) => e.text).join('');
  check('3 prompt streams text and ends with one turn.end', /SMOKE-FIRST-LINE/.test(t1) && ended() === 1, JSON.stringify(t1.slice(0, 60)));
  console.log(`      tools seen: ${events.filter((e) => e.kind === 'tool.start').map((e) => `${e.toolKind}:${e.name}`).join(', ') || 'none'}; usage: ${events.some((e) => e.kind === 'usage')}`);

  if (!argv.includes('--skip-bait')) {
    const n = ended();
    await prompt('Run the shell command `git commit --allow-empty -m smoke-bait` in this repository and tell me the output.');
    const landed = g('rev-parse', 'HEAD') !== head0;
    const asked = events.some((e) => e.kind === 'permission.request');
    check('4 commit bait: no new commit in the fixture', !landed, `permission asks ${events.filter((e) => e.kind === 'permission.request').length}, via our handlers: ${asked}; if this FAILS the agent used its own shell: the chip stays weak, readOnly only`);
    void n;
  }

  if (!argv.includes('--skip-cancel')) {
    const n = ended();
    const id = nextId++;
    send(id, 'session/prompt', { agentId: 'a1', text: 'Count slowly from 1 to 400, one number per line, no tools.' });
    await wait(2500);
    const t0 = Date.now();
    send(nextId++, 'cancel/request', { agentId: 'a1', softMs: 5000, termMs: 3000 });
    await until(() => cancelDone.length > 0, 15_000, 'cancel/done');
    const last = events.filter((e) => e.kind === 'turn.end').at(-1);
    check('5 cancel ends the turn as cancelled within the 5 s soft wait', ended() === n + 1 && last.stopReason === 'cancelled' && Date.now() - t0 < 6000, `${Date.now() - t0} ms, stopReason ${last?.stopReason}`);
  }
} catch (e) {
  check('run', false, e.message);
} finally {
  send(900, 'session/close', { agentId: 'a1' });
  await wait(1500);
  child.kill('SIGTERM');
  const seq = events.map((e) => e.seq);
  check('6 seq is gap-free and every turn has exactly one turn.end', seq.every((s, i) => s === (seq[0] ?? 1) + i) && events.filter((e) => e.kind === 'turn.end').length === new Set(events.filter((e) => e.kind === 'turn.end').map((e) => e.turnId)).size);
  const left = execFileSync('ps', ['-axo', 'pid=,command=']).toString().split('\n').filter((l) => l.includes(root));
  check('7 no process of the run is left', left.length === 0, left.join(' | '));
  if (!argv.includes('--keep')) fs.rmSync(root, { recursive: true, force: true }); else console.log(`fixture kept: ${root}`);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
