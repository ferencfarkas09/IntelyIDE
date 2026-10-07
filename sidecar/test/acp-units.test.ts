// Pure parts of the ACP adapter: caps from initialize + config options, mode/effort words, tool-call classification, update mapping, jail.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeCaps, configView, modelsOf } from '../src/adapters/acp/caps.js';
import { commandOf, intentFor, shellQuote, toolKindOf } from '../src/adapters/acp/intent.js';
import { Jail, JailError } from '../src/adapters/acp/jail.js';
import { flushSegment, mapUpdate, newMapState, resetTurn } from '../src/adapters/acp/map.js';
import { abstractMode, isUnsafeMode, modeFor, pickEffort } from '../src/adapters/acp/modes.js';
import { cleanTmp, tmp } from './acp-rig.js';

afterEach(cleanTmp);

const select = (id: string, category: string | undefined, current: string, values: string[]) =>
  ({ id, name: id, type: 'select', ...(category ? { category } : {}), currentValue: current, options: values.map((v) => ({ value: v, name: v.toUpperCase() })) });

describe('caps from initialize + config options', () => {
  it('effort comes from thought_level, the model list from the model category, grouped options are flattened', () => {
    const view = configView([
      { id: 'm', name: 'Model', type: 'select', category: 'model', currentValue: 'a', options: [{ group: 'g', name: 'G', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] }] },
      select('t', 'thought_level', 'low', ['low', 'high']),
      { id: 'flag', name: 'Flag', type: 'boolean', currentValue: true },
    ]);
    expect(modelsOf(view)).toEqual([{ id: 'a', label: 'A', effortLevels: ['low', 'high'] }, { id: 'b', label: 'B', effortLevels: ['low', 'high'] }]);
    const caps = computeCaps({ agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } }, view);
    expect(caps).toMatchObject({ effort: { cap: 'yes' }, effortLevels: ['low', 'high'], modelList: { cap: 'yes' }, modelSwitch: { cap: 'partial' }, resume: { cap: 'yes' }, attachments: 'images' });
  });

  it('no thought_level option means effort n/a from caps, not from a special case; an unknown agent is "partial", a known one "no"', () => {
    const known = computeCaps({ agentCapabilities: {} }, configView([]));
    expect(known.effort.cap).toBe('no');
    expect(known.effortLevels).toEqual([]);
    expect(known.resume.cap).toBe('no');
    expect(known.attachments).toBe('none');
    const unknown = computeCaps(undefined);
    expect(unknown.effort.cap).toBe('partial');
    expect(unknown.cancel.cap).toBe('yes');
    expect(unknown.sandbox.cap).toBe('no');
  });

  it('falls back to the option id when an agent leaves the category out, and to legacy modes without a mode option', () => {
    const v = configView([select('model', undefined, 'x', ['x'])], { currentModeId: 'plan', availableModes: [{ id: 'plan', name: 'Plan' }, { id: 'default', name: 'Default' }] });
    expect(v.model?.current).toBe('x');
    expect(v.legacyModes?.current).toBe('plan');
    expect(modeFor('readOnly', v)).toBe('plan');
    expect(modeFor('ask', v)).toBe('default');
  });
});

describe('modes and effort words', () => {
  it('maps agent mode ids to the abstract ladder and never selects an unsafe mode', () => {
    expect(['plan', 'default', 'autoEdit', 'acceptEdits', 'yolo', 'bypassPermissions'].map(abstractMode)).toEqual(['readOnly', 'ask', 'edit', 'edit', 'bypass', 'bypass']);
    expect(isUnsafeMode('dontAsk')).toBe(true);
    const v = configView([select('mode', 'mode', 'default', ['default', 'yolo', 'plan'])]);
    expect(modeFor('readOnly', v)).toBe('plan');
    expect(modeFor('edit', v)).toBeUndefined(); // only yolo-like words contain "edit"-free names here; nothing safe matches
    expect(modeFor('automatic', v)).toBeUndefined();
  });

  it('clamps effort to the agent levels and says so', () => {
    const c = configView([select('t', 'thought_level', 'medium', ['low', 'medium', 'high'])]).thought!.choices;
    expect(pickEffort(c, 'high')).toEqual({ value: 'high' });
    expect(pickEffort(c, 'xhigh')).toEqual({ value: 'high', clamped: true });
    expect(pickEffort(c, 'max')).toEqual({ value: 'high', clamped: true });
    expect(pickEffort([], 'high')).toEqual({});
  });
});

describe('tool call -> ToolIntent (providers-plan 5.4)', () => {
  const cwd = '/work/repo';
  it('judges what runs (rawInput) rather than what is shown (title)', () => {
    const i = intentFor({ toolCallId: 'c', title: 'List files', kind: 'other', rawInput: { command: ['git', 'push', 'origin', 'my branch'] } }, cwd);
    expect(i).toMatchObject({ class: 'exec', rawCommand: "git push origin 'my branch'" });
    expect(intentFor({ toolCallId: 'c', title: '`npm test`', kind: 'execute' }, cwd)).toMatchObject({ class: 'exec', rawCommand: 'npm test' });
  });

  it('classifies edits (also by diff content or write-shaped input) as write with absolute paths', () => {
    expect(intentFor({ toolCallId: 'c', title: 'Edit', kind: 'edit', locations: [{ path: 'src/a.ts' }] }, cwd)).toMatchObject({ class: 'write', paths: ['/work/repo/src/a.ts'] });
    expect(intentFor({ toolCallId: 'c', title: 'x', kind: 'other', content: [{ type: 'diff', path: '/work/repo/.husky/pre-commit' }] }, cwd)).toMatchObject({ class: 'write', paths: ['/work/repo/.husky/pre-commit'] });
    expect(intentFor({ toolCallId: 'c', title: 'x', kind: 'other', rawInput: { file_path: 'a.ts', new_string: 'b' } }, cwd).class).toBe('write');
  });

  it('read, fetch, mcp, and unknown (fail closed to other)', () => {
    expect(intentFor({ toolCallId: 'c', title: 'Read', kind: 'read', rawInput: { path: '/etc/passwd' } }, cwd)).toMatchObject({ class: 'read', paths: ['/etc/passwd'] });
    expect(intentFor({ toolCallId: 'c', title: 'Fetch', kind: 'fetch', rawInput: { url: 'https://x.test' } }, cwd)).toMatchObject({ class: 'net', url: 'https://x.test' });
    expect(intentFor({ toolCallId: 'c', title: 'gh', name: 'mcp__github__get_issue', kind: 'other' }, cwd)).toMatchObject({ class: 'mcp', server: 'github' });
    const other = intentFor({ toolCallId: 'c', title: 'Mystery', kind: 'think', rawInput: { token: 'sk-ant-abcdefghijkl' } }, cwd);
    expect(other.class).toBe('other');
    expect(other.summary).not.toContain('sk-ant-abcdefghijkl');
  });

  it('quotes so the shell parser reads back the same argv', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote('a-b/c.d')).toBe('a-b/c.d');
    expect(commandOf({ cmd: 'ls -la' })).toBe('ls -la');
    expect(commandOf({})).toBeUndefined();
    expect(toolKindOf('execute')).toBe('exec');
    expect(toolKindOf('switch_mode')).toBe('other');
    expect(toolKindOf('other', 'mcp__x__y')).toBe('mcp');
  });
});

describe('update mapping', () => {
  const text = (t: string, extra: object = {}) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t }, ...extra });

  it('closes a message segment before a tool call and when the kind switches', () => {
    const st = newMapState(() => 1000);
    const out = [
      ...mapUpdate(st, text('a')), ...mapUpdate(st, text('b')),
      ...mapUpdate(st, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 't' } }),
      ...mapUpdate(st, text('c')),
      ...mapUpdate(st, { sessionUpdate: 'tool_call', toolCallId: 'x', title: 'T', kind: 'execute', status: 'pending' }),
      ...flushSegment(st),
    ];
    expect(out.map((e) => e.kind)).toEqual(['text.delta', 'text.delta', 'text.done', 'thinking.delta', 'text.delta', 'text.done', 'tool.start']);
    expect((out[2] as any).text).toBe('ab');
  });

  it('redacts secrets in text, tool input and output', () => {
    const st = newMapState();
    const t: any = mapUpdate(st, text('key sk-ant-abcdefghijklmn'))[0];
    expect(t.text).not.toContain('abcdefghijklmn');
    const s: any = mapUpdate(st, { sessionUpdate: 'tool_call', toolCallId: 'x', title: 'T', kind: 'execute', rawInput: { command: 'echo', env: { API_KEY: 'supersecretvalue1' } } }).find((e) => e.kind === 'tool.start');
    expect(JSON.stringify(s.input)).not.toContain('supersecretvalue1');
  });

  it('a failed update of a tool the broker refused is "denied"; a repeated tool_call is an update; unknown kinds are ignored', () => {
    const st = newMapState();
    mapUpdate(st, { sessionUpdate: 'tool_call', toolCallId: 'x', title: 'T', kind: 'execute' });
    st.denied.add('x');
    expect(mapUpdate(st, { sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'failed' })[0]).toMatchObject({ kind: 'tool.result', status: 'denied' });
    expect(mapUpdate(st, { sessionUpdate: 'from_the_future', whatever: 1 })).toEqual([]);
    resetTurn(st);
    expect(st.tools.size).toBe(0);
  });

  it('shows the output of one of our terminals on its tool card', () => {
    const st = newMapState();
    st.terminalText = (id) => (id === 'term-1' ? 'hello\n' : undefined);
    mapUpdate(st, { sessionUpdate: 'tool_call', toolCallId: 'x', title: 'T', kind: 'execute' });
    const r: any = mapUpdate(st, { sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'completed', content: [{ type: 'terminal', terminalId: 'term-1' }] })[0];
    expect(r.output).toBe('hello\n');
  });
});

describe('path jail', () => {
  it('stays inside cwd and add-dirs, resolves symlinks, protects git/hook/agent directories for writes only', () => {
    const root = tmp();
    const cwd = path.join(root, 'repo');
    const extra = path.join(root, 'extra');
    const outside = path.join(root, 'outside');
    for (const d of [cwd, extra, outside, path.join(cwd, '.git')]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(cwd, '.git/config'), '[core]');
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'one\ntwo\nthree');
    fs.writeFileSync(path.join(outside, 's.txt'), 'secret');
    fs.symlinkSync(outside, path.join(cwd, 'out'));
    fs.symlinkSync(path.join(outside, 'dangling'), path.join(cwd, 'dangling'));
    const j = new Jail(cwd, [extra]);
    expect(j.readText(path.join(cwd, 'a.txt'), 2, 1)).toBe('two');
    expect(j.readText(path.join(cwd, '.git/config'))).toBe('[core]'); // reading is the broker's call, not the jail's
    expect(() => j.resolve(path.join(cwd, 'out/s.txt'), 'read')).toThrow(JailError);
    expect(() => j.resolve(path.join(cwd, '..', 'outside', 's.txt'), 'read')).toThrow(JailError);
    expect(() => j.resolve('relative.txt', 'read')).toThrow(/absolute/);
    expect(() => j.resolve(path.join(cwd, '.git/hooks/pre-commit'), 'write')).toThrow(/protected/);
    expect(() => j.resolve(path.join(cwd, 'sub/.husky/x'), 'write')).toThrow(/protected/);
    // the volume may be case-insensitive (APFS): .GIT is the real .git there
    for (const d of ['.GIT/hooks/pre-commit', '.Husky/pre-commit', '.CLAUDE/settings.json']) expect(() => j.resolve(path.join(cwd, d), 'write'), d).toThrow(/protected/);
    expect(() => j.writeText(path.join(cwd, 'dangling'), 'x')).toThrow(JailError);
    expect(fs.existsSync(path.join(outside, 'dangling'))).toBe(false);
    j.writeText(path.join(extra, 'deep/new.txt'), 'ok');
    expect(fs.readFileSync(path.join(extra, 'deep/new.txt'), 'utf8')).toBe('ok');
    expect(() => j.readText(path.join(cwd))).toThrow(/not a file/);
  });
});
