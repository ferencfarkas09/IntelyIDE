// Live check of notes to a working agent against the installed claude CLI (Haiku, tiny prompts). Skipped unless INTELY_LIVE=1:
//   INTELY_LIVE=1 INTELY_CLAUDE_BIN=<claude> pnpm --filter @intely/sidecar test claude-notes-live        (about 5 model calls)
// A researcher sub-agent runs three slow shell commands; a note added after its first call must come back as queued, then delivered with
// a LATER call of the same sub-agent (the PreToolUse hook's additionalContext), and the sub-agent must act on it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkInvariants } from '../src/turn.js';
import { dropTranscripts, FakeHost } from '../../tests/fakes/fake-host.mjs';

const LIVE = process.env.INTELY_LIVE === '1';
const CLAUDE = process.env.INTELY_CLAUDE_BIN ?? (LIVE ? execFileSync('/bin/zsh', ['-ilc', 'command -v claude']).toString().trim().split('\n').pop()! : '');
const HAIKU = 'claude-haiku-4-5-20251001';
const CODEWORD = 'PINEAPPLE-7';
const dirs: string[] = [];
const hosts: any[] = [];

function fixture(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'isw-notes-live-')));
  dirs.push(dir);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, env });
  g('init', '-q', '-b', 'main'); g('config', 'user.name', 'F'); g('config', 'user.email', 'f@example.invalid');
  for (const [name, text] of [['a.txt', 'alpha'], ['b.txt', 'bravo'], ['c.txt', 'charlie']]) fs.writeFileSync(path.join(dir, name), `${text}\n`);
  g('add', '.'); g('commit', '-q', '-m', 'init');
  return dir;
}
afterAll(async () => { for (const h of hosts) await h.stop().catch(() => undefined); for (const d of dirs) { dropTranscripts(d); fs.rmSync(d, { recursive: true, force: true }); } });

describe.skipIf(!LIVE)('notes to a working agent, live', () => {
  it('a note added while a sub-agent works is delivered with its next tool call and the sub-agent acts on it', async () => {
    const cwd = fixture();
    const h = await new FakeHost({ providers: ['claude'], policy: () => ({ decision: 'allow', by: 'default', rule: 'live.allow' }) }).start();
    hosts.push(h);
    const delegates = [{
      name: 'researcher', description: 'Runs shell commands one at a time and reports what they print. Use it for any question about file contents.',
      prompt: 'You run the commands you are given with the Bash tool, strictly one per call, waiting for each result before the next. Then you report what they printed, one line each. Follow any note the user adds while you work.',
      model: HAIKU, permission: 'readOnly', tools: ['Bash', 'Read'], disallowedTools: ['Agent', 'Task'], maxTurns: 8, scope: 'global',
    }];
    const started = await h.startSession({
      agentId: 'n1', provider: 'claude', cwd, env: { claudeBin: CLAUDE, shimDir: '/tmp/isw-live-shim' }, auth: { mode: 'subscription', key: null }, delegates,
      role: { name: 'auto', model: HAIKU, permission: 'edit', maxTurns: 6, maxBudgetUsd: 0.2 },
    });
    expect(started).toMatchObject({ ok: true });
    await h.prompt('n1', 'Start the researcher agent (foreground, run_in_background false). Tell it to run these three commands one at a time with the Bash tool: `sleep 4; cat a.txt`, then `sleep 4; cat b.txt`, then `sleep 4; cat c.txt`, and to report the three outputs. Then repeat its report to me word for word.');

    // the Agent call, then the sub-agent's first tool call: from here a note has a target and something left to ride on
    const agentStart = await h.waitEvent('n1', (e: any) => e.kind === 'tool.start' && (e.name === 'Agent' || e.name === 'Task'), 90000);
    const first = await h.waitEvent('n1', (e: any) => e.kind === 'tool.start' && e.parentToolId === agentStart.toolId, 90000);
    const reply = await h.request('session/note', { agentId: 'n1', noteId: 'note-1', text: `Also end your report with the exact word ${CODEWORD}.`, parentToolId: agentStart.toolId });
    expect(reply).toEqual({ ok: true });

    const ev = await h.waitTurnEnd('n1', 1, 180000);
    const notes = ev.filter((e: any) => e.kind === 'note' && e.noteId === 'note-1');
    console.log('[live-note] timeline', JSON.stringify(ev.filter((e: any) => ['tool.start', 'tool.result', 'note'].includes(e.kind)).map((e: any) => `${e.seq}:${e.kind}${e.state ? `/${e.state}` : ''}:${e.name ?? ''}:${String(e.toolId ?? '').slice(-6)}<${String(e.parentToolId ?? '').slice(-6)}`)));
    console.log('[live-note] note events', JSON.stringify(notes.map((n: any) => ({ state: n.state, toolId: n.toolId, reason: n.reason }))));
    expect(notes.map((n: any) => n.state)).toEqual(['queued', 'delivered']);
    expect(notes[0]).toMatchObject({ text: `Also end your report with the exact word ${CODEWORD}.`, parentToolId: agentStart.toolId });
    expect(notes[1]).toMatchObject({ parentToolId: agentStart.toolId });
    expect(notes[1].toolId, 'it rode on a later call, not the one the sub-agent was already in').not.toBe(first.toolId);
    const rider = ev.find((e: any) => e.kind === 'tool.start' && e.toolId === notes[1].toolId);
    expect(rider?.parentToolId, 'the call it rode on belongs to the same sub-agent').toBe(agentStart.toolId);

    const agentResult = ev.find((e: any) => e.kind === 'tool.result' && e.toolId === agentStart.toolId);
    const lead = ev.filter((e: any) => e.kind === 'text.done' && !e.parentToolId).map((e: any) => e.text).join('\n');
    console.log('[live-note] sub-agent report:', JSON.stringify(String(agentResult?.output ?? '').slice(0, 400)));
    expect(`${agentResult?.output ?? ''}\n${lead}`, 'the sub-agent acted on the note').toContain(CODEWORD);
    expect(checkInvariants(ev)).toEqual([]);
    await h.closeSession('n1');
  }, 300000);

  it('a note for the lead rides on the lead\'s next call, and a note for a sub-agent that is gone is refused', async () => {
    const cwd = fixture();
    const h = await new FakeHost({ providers: ['claude'], policy: () => ({ decision: 'allow', by: 'default', rule: 'live.allow' }) }).start();
    hosts.push(h);
    await h.startSession({
      agentId: 'n2', provider: 'claude', cwd, env: { claudeBin: CLAUDE, shimDir: '/tmp/isw-live-shim' }, auth: { mode: 'subscription', key: null },
      role: { name: 'dev', model: HAIKU, permission: 'edit', maxTurns: 6, maxBudgetUsd: 0.2 },
    });
    await h.prompt('n2', 'Run these three commands one at a time with the Bash tool, each in its own call: `sleep 4; cat a.txt`, `sleep 4; cat b.txt`, `sleep 4; cat c.txt`. Then tell me what they printed.');
    const first = await h.waitEvent('n2', (e: any) => e.kind === 'tool.start' && e.name === 'Bash', 90000);
    expect(await h.request('session/note', { agentId: 'n2', noteId: 'note-2', text: `Finish your final answer with the exact word ${CODEWORD}.` })).toEqual({ ok: true });
    expect(await h.request('session/note', { agentId: 'n2', noteId: 'note-3', text: 'hello', parentToolId: 'toolu_does_not_exist' })).toMatchObject({ error: 'unknownTarget' });
    const ev = await h.waitTurnEnd('n2', 1, 180000);
    const notes = ev.filter((e: any) => e.kind === 'note' && e.noteId === 'note-2');
    console.log('[live-note] lead note events', JSON.stringify(notes.map((n: any) => ({ state: n.state, toolId: n.toolId, reason: n.reason }))));
    expect(notes.map((n: any) => n.state)).toEqual(['queued', 'delivered']);
    expect(notes[1].toolId).not.toBe(first.toolId);
    const answer = ev.filter((e: any) => e.kind === 'text.done').map((e: any) => e.text).join('\n');
    expect(answer).toContain(CODEWORD);
    expect(checkInvariants(ev)).toEqual([]);
    // nothing is working now
    expect(await h.request('session/note', { agentId: 'n2', noteId: 'note-4', text: 'anyone?' })).toMatchObject({ error: 'noTurn' });
    await h.closeSession('n2');
  }, 300000);
});
