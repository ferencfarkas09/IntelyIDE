// mapRaw golden tests: recorded SDK streams (fixtures/golden, sanitized) -> normalized events, compared against checked-in
// expectations, plus the invariants and the scan that keeps paths, tokens and the MCP/skill/command inventory out of the fixtures.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCredential } from '../src/adapters/claude-sdk/facts.js';
import { intentFor } from '../src/adapters/claude-sdk/intent.js';
import { mapRaw, newMapState, type Raw } from '../src/adapters/claude-sdk/map.js';
import { checkInvariants } from '../src/turn.js';
import type { PermissionMode, WireEvent } from '../src/types.js';
import { sanitize, scan } from '../../scripts/lib/golden.mjs';

const GOLDEN = path.resolve(__dirname, '../../fixtures/golden');
const dirs = ['', 'adapter'];
const files = dirs.flatMap((d) => (fs.existsSync(path.join(GOLDEN, d)) ? fs.readdirSync(path.join(GOLDEN, d)).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(d, f)) : [])).sort();

const read = (f: string) => fs.readFileSync(path.join(GOLDEN, f), 'utf8');
const lines = (f: string): Raw[] => read(f).split('\n').filter(Boolean).map((l) => JSON.parse(l));

// The recordings predate the IDE modes: the mode the session "held" is the one the CLI reported in the init of the recording.
const IDE_MODE_OF_RECORDING: Record<string, PermissionMode> = { plan: 'readOnly', default: 'ask', acceptEdits: 'edit' };

function replay(f: string) {
  let t = 1_790_000_000_000;
  let mode: PermissionMode = 'ask';
  const state = newMapState({
    now: () => (t += 10),
    describeInit: (init) => ({ effort: null, auth: checkCredential('subscription', String(init.apiKeySource), false), assertions: [] }),
    mode: () => mode,
  });
  const events: WireEvent[] = [];
  const raws: Raw[] = [];
  let seq = 1;
  for (const m of lines(f)) {
    if (m.type === 'system' && m.subtype === 'init' && !state.started) mode = IDE_MODE_OF_RECORDING[String(m.permissionMode)] ?? 'ask';
    for (const e of mapRaw(state, m)) {
      raws.push(m);
      events.push({ ...e, seq: seq++, ts: 0 } as WireEvent);
    }
  }
  return { events, raws, state };
}

describe('golden fixtures: hygiene', () => {
  it('there are recordings', () => expect(files.length).toBeGreaterThanOrEqual(9));
  for (const f of files) {
    it(`${f} has no local paths, token-like strings or inventory names`, () => {
      expect(scan(read(f), f)).toEqual([]);
    });
    it(`${f} is stable under the sanitizer`, () => {
      const again = lines(f).map((m) => JSON.stringify(sanitize(m))).join('\n');
      expect(again).toBe(read(f).trimEnd());
    });
  }
  it('the scan actually catches what it claims to catch', () => {
    const dirty = [
      JSON.stringify({ type: 'system', subtype: 'init', cwd: '/Users/someone/x', slash_commands: ['deploy'], skills: [], agents: [], mcp_servers: [{ name: 'claude.ai Mail' }], plugins: [], tools: ['mcp__a__b'] }),
      JSON.stringify({ type: 'assistant', text: 'key sk-ant-api03-abcdefghijklmnop and Bearer abcdefghijklmnopqrstuvwxyz' }),
    ].join('\n');
    const found = scan(dirty, 'dirty').join('\n');
    for (const needle of ['home path', 'slash command inventory', 'MCP server name', 'MCP tool name', 'anthropic key', 'bearer token']) expect(found).toContain(needle);
  });
});

describe('golden fixtures: mapRaw', () => {
  for (const f of files) {
    const name = f.replace(/\.jsonl$/, '');
    const expectedDir = path.dirname(f) === '.' ? 'expected' : path.join(path.dirname(f), 'expected');
    it(`${f}: normalized events match and keep the invariants`, async () => {
      const { events } = replay(f);
      expect(checkInvariants(events)).toEqual([]);
      const slim = events.map(({ raw: _raw, ...rest }) => rest);
      await expect(`${JSON.stringify(slim, null, 1)}\n`).toMatchFileSnapshot(path.join(GOLDEN, expectedDir, `${path.basename(name)}.events.json`));
    });
    it(`${f}: events keep the raw message they came from`, () => {
      const { events, raws } = replay(f);
      events.forEach((e, i) => {
        if (e.raw === undefined) return;
        const r = e.raw as Raw;
        if (r._truncated) expect(r.type).toBe(raws[i].type);
        else expect(r).toEqual(raws[i]);
      });
    });
  }

  const kinds = (f: string) => replay(f).events.map((e) => e.kind);

  it('01 plain reply streams text.delta then text.done and ends endTurn', () => {
    const { events } = replay('01-plain-text-partial.jsonl');
    const delta = events.find((e) => e.kind === 'text.delta');
    const done = events.find((e) => e.kind === 'text.done');
    expect(delta && 'text' in delta ? delta.text : null).toBe('OK');
    expect(done && 'messageId' in done && delta && 'messageId' in delta ? done.messageId : 'x').toBe(delta && 'messageId' in delta ? delta.messageId : 'y');
    expect(events.at(-1)).toMatchObject({ kind: 'turn.end', stopReason: 'endTurn' });
    expect(events[0]).toMatchObject({ kind: 'session.started', auth: { mode: 'subscription', source: 'none' } });
  });

  it('02 tool allow: tool.start/result pair with a diff from the Write input', () => {
    const { events } = replay('02-tool-allow.jsonl');
    const start = events.find((e) => e.kind === 'tool.start');
    const res = events.find((e) => e.kind === 'tool.result');
    expect(start).toMatchObject({ name: 'Write', toolKind: 'edit' });
    expect(res).toMatchObject({ status: 'ok', diff: { old: null } });
  });

  it('03 deny: the host message reaches the error result', () => {
    const res = replay('03-tool-deny.jsonl').events.find((e) => e.kind === 'tool.result');
    expect(res).toMatchObject({ status: 'error' });
    expect(res && 'output' in res ? res.output : '').toContain('DENIED-BY-HOST-TEST');
  });

  it('04 subagent: child tool and text carry parentToolId of the Agent tool', () => {
    const { events } = replay('04-subagent-task.jsonl');
    const agent = events.find((e) => e.kind === 'tool.start' && e.name === 'Agent');
    expect(agent).toBeTruthy();
    const child = events.filter((e) => e.kind === 'text.done' && 'parentToolId' in e && e.parentToolId);
    expect(child.length).toBeGreaterThan(0);
    expect(child[0]).toMatchObject({ parentToolId: agent && 'toolId' in agent ? agent.toolId : '' });
    expect(kinds('04-subagent-task.jsonl')).toContain('tool.update');
  });

  it('05 interrupt: the aborted turn is cancelled, later turns end normally, usage never double counts', () => {
    const { events } = replay('05-interrupted.jsonl');
    const ends = events.filter((e) => e.kind === 'turn.end').map((e) => (e as { stopReason: string }).stopReason);
    expect(ends).toEqual(['cancelled', 'endTurn', 'endTurn']);
    const raws = lines('05-interrupted.jsonl').filter((m) => m.type === 'result');
    const usage = events.filter((e) => e.kind === 'usage') as Extract<WireEvent, { kind: 'usage' }>[];
    const sum = usage.reduce((a, u) => a + (u.usage.perTurn.costUsd ?? 0), 0);
    expect(sum).toBeCloseTo(raws.at(-1)!.total_cost_usd, 6);
    expect(usage.at(-1)!.usage.cumulative.costUsd).toBeCloseTo(raws.at(-1)!.total_cost_usd, 6);
  });

  it('06 deny with interrupt ends the turn as cancelled', () => {
    expect(replay('06-deny-interrupt.jsonl').events.at(-1)).toMatchObject({ kind: 'turn.end', stopReason: 'cancelled' });
  });

  it('07 resume: a resumed process starts its own totals at zero (cumulative == perTurn)', () => {
    const u = replay('07-resume.jsonl').events.find((e) => e.kind === 'usage') as Extract<WireEvent, { kind: 'usage' }>;
    expect(u.usage.cumulative).toEqual(u.usage.perTurn);
    expect(replay('07-resume.jsonl').events[0]).toMatchObject({ kind: 'session.started' });
  });

  it('08 AskUserQuestion shows up as a tool, answered through the tool_result', () => {
    const { events } = replay('08-ask-user-question.jsonl');
    expect(events.find((e) => e.kind === 'tool.start' && e.name === 'AskUserQuestion')).toBeTruthy();
    expect(events.find((e) => e.kind === 'tool.result')).toMatchObject({ status: 'ok' });
  });

  describe('recorded through the adapter (fixtures/golden/adapter)', () => {
    const A = (n: string) => path.join('adapter', n);
    it('01 plain reply: facts are clean, credential is the login', () => {
      const { events } = replay(A('01-plain-text-partial.jsonl'));
      expect(events[0]).toMatchObject({ kind: 'session.started', model: 'claude-haiku-4-5-20251001', auth: { source: 'none' } });
      expect(events.at(-1)).toMatchObject({ kind: 'turn.end', stopReason: 'endTurn' });
    });
    it('03 deny: the host message reaches the error result', () => {
      const res = replay(A('03-tool-deny.jsonl')).events.find((e) => e.kind === 'tool.result');
      expect(res && 'output' in res ? res.output : '').toContain('DENIED-BY-HOST-TEST');
    });
    it('05 interrupt: cancelled, then two normal turns, Writes carry diffs', () => {
      const { events } = replay(A('05-interrupted.jsonl'));
      expect(events.filter((e) => e.kind === 'turn.end').map((e) => (e as { stopReason: string }).stopReason)).toEqual(['cancelled', 'endTurn', 'endTurn']);
      expect(events.filter((e) => e.kind === 'tool.result' && 'diff' in e && e.diff)).toHaveLength(2);
    });
    it('07 resume keeps the native session id and starts its own usage totals', () => {
      const { events } = replay(A('07-resume.jsonl'));
      expect(events[0]).toMatchObject({ kind: 'session.started', nativeId: '5d0b4c1a-2f6e-4a8e-9c11-0123456789ab' });
      const u = events.find((e) => e.kind === 'usage') as Extract<WireEvent, { kind: 'usage' }>;
      expect(u.usage.cumulative).toEqual(u.usage.perTurn);
    });
    it('08 AskUserQuestion is a tool that completes', () => {
      const { events } = replay(A('08-ask-user-question.jsonl'));
      expect(events.find((e) => e.kind === 'tool.start' && e.name === 'AskUserQuestion')).toBeTruthy();
      expect(events.find((e) => e.kind === 'tool.result')).toMatchObject({ status: 'ok' });
    });
  });

  it('09 default settings leak: hook events exist in the raw stream but never become events', () => {
    const hookMsgs = lines('09-default-settings-hook-events.jsonl').filter((m) => /^hook_/.test(m.subtype ?? ''));
    expect(hookMsgs.length).toBeGreaterThan(0);
    expect(kinds('09-default-settings-hook-events.jsonl').filter((k) => k.startsWith('hook'))).toEqual([]);
  });
});

describe('delegation golden cases (packages/protocol/fixtures/delegation-cases.json, written by the Rust broker tests)', () => {
  type DCase = { name: string; actor: { agentId: string; role: string } | null; tool: string; input: unknown; intent: Record<string, unknown> };
  const cases = (JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../packages/protocol/fixtures/delegation-cases.json'), 'utf8')) as { cases: DCase[] }).cases;
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.length ? v.map(norm) : undefined;
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k, x]) => x !== null && k !== 'summary' && norm(x) !== undefined).map(([k, x]) => [k, norm(x)]));
    return v === '' ? undefined : v;
  };

  it('there are cases for every actor shape', () => {
    expect(cases.length).toBeGreaterThanOrEqual(90);
    expect(new Set(cases.map((c) => c.actor?.role ?? 'lead'))).toEqual(expect.objectContaining(new Set(['lead', 'researcher', 'writer', 'dev', '?'])));
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s: the sidecar maps the call to the intent Rust judged, actor included', (_n, c) => {
    const got = intentFor(c.tool, c.input, undefined, c.actor ?? undefined);
    expect(norm(got)).toEqual(norm(c.intent));
  });
});
