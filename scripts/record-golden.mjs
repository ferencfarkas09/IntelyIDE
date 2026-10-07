#!/usr/bin/env node
// Records golden SDK message streams THROUGH THE REAL ADAPTER (sidecar/dist/testkit.js, Haiku, tiny prompts), sanitizes them
// (scripts/lib/golden.mjs) and refuses to write anything the hygiene scan still flags.
//   node scripts/record-golden.mjs [--only 01,03] [--out fixtures/golden/adapter] [--list]
// Scenarios mirror fixtures/golden (the Phase 0 spike recordings) where the adapter can drive them:
//   01 plain reply (partial messages)   02 Write allowed through the UI prompt   03 Write denied through the UI prompt
//   05 interrupt, follow-up Write, setPermission + setModel   07 create then resume   08 AskUserQuestion
// Not reproducible through the adapter: 04 (needs custom subagent definitions), 06 (deny+interrupt), 09 (default settings are
// exactly what the adapter isolates away). Build first: pnpm --filter @intely/sidecar build.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dropTranscripts } from '../tests/fakes/fake-host.mjs';
import { sanitize, scan } from './lib/golden.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const OUT = path.resolve(flag('--out') ?? path.join(ROOT, 'fixtures', 'golden', 'adapter'));
const HAIKU = 'claude-haiku-4-5-20251001';
const CLAUDE = process.env.INTELY_CLAUDE_BIN ?? execFileSync('/bin/zsh', ['-ilc', 'command -v claude']).toString().trim().split('\n').pop();
const kit = await import(path.join(ROOT, 'sidecar', 'dist', 'testkit.js'));

let calls = 0;

async function record(name, drive, { permission = 'ask', addDirs = [], resume, sessionId, write = true, cwd: givenCwd } = {}) {
  const cwd = givenCwd ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'isw-rec-')));
  const raw = [];
  const events = [];
  const guard = new kit.TurnGuard(new kit.SeqSink((e) => events.push(e)));
  const policy = { decide: async () => ({ decision: 'ask', by: 'roleDeny' }) };
  const spec = {
    agentId: 'rec', provider: 'claude', cwd, addDirs, mcp: {}, auth: { mode: 'subscription', key: null },
    role: { name: 'rec', model: HAIKU, permission, maxTurns: 4, maxBudgetUsd: 0.1 },
    env: { claudeBin: CLAUDE, vars: { ...process.env } },
    ...(resume ? { resume } : {}), ...(sessionId ? { sessionId } : {}),
  };
  const session = await kit.ClaudeSession.open(spec, guard, policy, { registerPid() {} }, (m) => raw.push(m));
  const ctx = {
    session, events, cwd,
    waitFor: async (pred, ms = 90000) => { const t0 = Date.now(); while (!events.some(pred)) { if (Date.now() - t0 > ms) throw new Error(`timeout in ${name}: ${events.slice(-4).map((e) => e.kind)}`); await new Promise((r) => setTimeout(r, 20)); } },
    turn: async (text, answer) => {
      const before = events.filter((e) => e.kind === 'turn.end').length;
      calls++;
      guard.beginTurn();
      session.prompt({ text });
      const t0 = Date.now();
      while (events.filter((e) => e.kind === 'turn.end').length === before) {
        if (Date.now() - t0 > 120000) throw new Error(`timeout in ${name}`);
        const req = events.find((e) => (e.kind === 'permission.request' || e.kind === 'question.request') && !e.answered);
        if (req && answer) { req.answered = true; session.answer(req.reqId, answer(req)); }
        await new Promise((r) => setTimeout(r, 20));
      }
    },
  };
  try {
    await drive(ctx);
  } finally {
    await session.close();
    if (!givenCwd) { dropTranscripts(cwd); fs.rmSync(cwd, { recursive: true, force: true }); }
  }
  if (!write) return;
  const text = `${raw.map((m) => JSON.stringify(sanitize(m))).join('\n')}\n`;
  const file = `${name}.jsonl`;
  const problems = scan(text, file);
  if (problems.length) throw new Error(`refusing to write ${file}:\n${problems.join('\n')}`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, file), text);
  console.log(`recorded ${file}: ${raw.length} messages, ${events.length} events`);
}

const SCENARIOS = {
  '01': ['01-plain-text-partial', (c) => c.turn('Reply with exactly the word: OK')],
  '02': ['02-tool-allow', (c) => c.turn('Use the Write tool to create a.txt with the content "original". Then stop.', () => ({ outcome: 'allow' })), { permission: 'edit' }],
  '03': ['03-tool-deny', (c) => c.turn('Use the Write tool to create b.txt with content "x". If it is refused, tell me the exact refusal reason in one sentence.', () => ({ outcome: 'deny', message: 'DENIED-BY-HOST-TEST: the human said no' })), { permission: 'edit' }],
  '05': ['05-interrupted', async (c) => {
    const first = c.turn('Count from 1 to 300, one number per line, no other text.');
    await c.waitFor((e) => e.kind === 'text.delta');
    await c.session.interrupt();
    await first;
    await c.turn('Use the Write tool to create d.txt with content "d". Then say DONE.', () => ({ outcome: 'allow' }));
    await c.session.setPermission('edit');
    await c.session.setModel(HAIKU);
    await c.turn('Use the Write tool to create e.txt with content "e". Then say DONE.', () => ({ outcome: 'allow' }));
  }],
  '07': ['07-resume', async () => {
    const sessionId = '5d0b4c1a-2f6e-4a8e-9c11-0123456789ab';
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'isw-rec-')));
    await record('07-create', (c) => c.turn('Remember the secret word PINEAPPLE. Reply with just OK.'), { sessionId, write: false, cwd });
    await record('07-resume', (c) => c.turn('What was the secret word? Answer with one word.'), { resume: { nativeId: sessionId }, cwd });
    dropTranscripts(cwd);
    fs.rmSync(cwd, { recursive: true, force: true });
  }],
  '08': ['08-ask-user-question', (c) => c.turn('You must call the AskUserQuestion tool exactly once: ask which colour I prefer, options Red and Blue. Then state my answer in one word.', (r) => ({ outcome: 'allow', answers: { [r.prompt]: 'Blue' } }))],
};

if (argv.includes('--list')) { for (const [k, v] of Object.entries(SCENARIOS)) console.log(k, v[0]); process.exit(0); }
const only = flag('--only')?.split(',') ?? Object.keys(SCENARIOS);
for (const k of only) {
  const s = SCENARIOS[k];
  if (!s) throw new Error(`unknown scenario ${k}`);
  if (k === '07') await s[1]();
  else await record(s[0], s[1], s[2]);
}
console.log(`model turns used: ${calls}`);
process.exit(0);
