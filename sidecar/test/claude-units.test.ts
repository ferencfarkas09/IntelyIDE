import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { capsFor, staticCaps } from '../src/adapters/claude-sdk/caps.js';
import { assertInit, checkCredential, type CliModel, isUnattended, isWriterMode, isolationLeak, modelMatches, permissionModeFor } from '../src/adapters/claude-sdk/facts.js';
import { intentFor, toolKind } from '../src/adapters/claude-sdk/intent.js';
import { DENY_RULES, settingsOverlay } from '../src/adapters/claude-sdk/settings.js';
import { ClaudeSession } from '../src/adapters/claude-sdk/session.js';
import type { ResolvedRole } from '../src/types.js';

// Shape of initializationResult().models[] as recorded in spikes/sdk/WIRE.md.
const MODELS: CliModel[] = [
  { value: 'default', resolvedModel: 'claude-sonnet-5-5', displayName: 'Default (recommended)', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
];
const role = (over: Partial<ResolvedRole> = {}): ResolvedRole => ({ name: 'dev', model: 'claude-haiku-4-5-20251001', permission: 'ask', ...over });
const init = (over: Record<string, unknown> = {}) => ({
  type: 'system', subtype: 'init', model: 'claude-haiku-4-5-20251001', permissionMode: 'default', apiKeySource: 'none',
  plugins: [{ name: 'agents-md', path: 'builtin' }, { name: 'telemetry', path: 'builtin' }], mcp_servers: [], ...over,
});
const facts = (over: Partial<Parameters<typeof assertInit>[0]> = {}) => assertInit({ init: init(), role: role(), mcpExpected: [], models: MODELS, appliedEffort: null, foreignHookEvents: 0, ...over });

describe('ProviderCaps from the CLI model catalog (no per-model special case)', () => {
  it('Haiku: effort is "no" with no levels, derived from supportsEffort', () => {
    const c = capsFor(MODELS[1]);
    expect(c.effort.cap).toBe('no');
    expect(c.effortLevels).toEqual([]);
  });
  it('Sonnet: effort is "yes" with the catalog levels', () => {
    const c = capsFor(MODELS[2]);
    expect(c.effort.cap).toBe('yes');
    expect(c.effortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
  it('a model missing from the catalog gets no effort rather than a guess', () => {
    expect(capsFor(undefined).effort.cap).toBe('no');
  });
  it('static caps (before any CLI runs) say effort depends on the model', () => {
    expect(staticCaps().effort.cap).toBe('partial');
    expect(staticCaps().sandbox.cap).toBe('partial');
  });
});

describe('init-facts assertion', () => {
  it('is silent for a clean isolated session', () => expect(facts()).toEqual([]));
  it('flags a wrong model, permission mode, plugin, MCP set and a foreign hook event', () => {
    const bad = facts({
      init: init({ model: 'claude-opus-5-5', permissionMode: 'acceptEdits', plugins: [{ name: 'x', path: '/p' }], mcp_servers: [{ name: 'gmail', status: 'failed' }] }),
      foreignHookEvents: 2,
    }).join('\n');
    for (const n of ['model:', 'permission mode:', 'plugins:', 'mcp servers:', 'failed to start', 'hooks:']) expect(bad).toContain(n);
  });
  it('accepts the aliases a role may use for the same model', () => {
    expect(modelMatches('haiku', 'claude-haiku-4-5-20251001', MODELS)).toBe(true);
    expect(modelMatches('claude-haiku-4-5', 'claude-haiku-4-5-20251001', MODELS)).toBe(true);
    expect(modelMatches('sonnet', 'claude-haiku-4-5-20251001', MODELS)).toBe(false);
  });
  it('effort: n/a on Haiku is fine, an applied effort on a no-effort model is not, a downgrade is reported', () => {
    expect(facts({ role: role({ effort: 'low' }), appliedEffort: null })).toEqual([]);
    expect(facts({ role: role({ effort: 'low' }), appliedEffort: 'low' }).join()).toContain('no effort control');
    const sonnet = init({ model: 'claude-sonnet-5-5' });
    expect(facts({ init: sonnet, role: role({ model: 'sonnet', effort: 'high' }), appliedEffort: 'high' })).toEqual([]);
    expect(facts({ init: sonnet, role: role({ model: 'sonnet', effort: 'high' }), appliedEffort: 'medium' }).join()).toContain('role asks "high", applied "medium"');
    expect(facts({ init: sonnet, role: role({ model: 'sonnet', effort: 'high' }), appliedEffort: null }).join()).toContain('applied "null"');
  });
  it('expects the MCP servers the session was given', () => {
    expect(facts({ init: init({ mcp_servers: [{ name: 'docs', status: 'connected' }] }), mcpExpected: ['docs'] })).toEqual([]);
    expect(facts({ init: init({ mcp_servers: [] }), mcpExpected: ['docs'] }).join()).toContain('mcp servers');
  });
  it('maps the five IDE modes to the three SDK modes the IDE uses, and still throws for anything else', () => {
    expect(permissionModeFor('readOnly')).toBe('plan');
    expect(permissionModeFor('ask')).toBe('default');
    expect(permissionModeFor('edit')).toBe('acceptEdits');
    // Automatic and Bypass are acceptEdits at the SDK level: the policy, not the CLI, removes the boundary (spec 6.1)
    expect(permissionModeFor('automatic')).toBe('acceptEdits');
    expect(permissionModeFor('bypass')).toBe('acceptEdits');
    for (const bad of ['auto', 'dontAsk', 'bypassPermissions', 'plan', '']) expect(() => permissionModeFor(bad as never), bad).toThrow(/not offered for Claude/);
  });
  it('isWriterMode and isUnattended mirror PermissionMode::is_writer / is_unattended', () => {
    expect((['readOnly', 'ask', 'edit', 'automatic', 'bypass'] as const).map(isWriterMode)).toEqual([false, false, true, true, true]);
    expect((['readOnly', 'ask', 'edit', 'automatic', 'bypass'] as const).map(isUnattended)).toEqual([false, false, false, true, true]);
  });
  it('assertInit compares the init mode with the mode the session holds NOW, not the role\'s', () => {
    expect(facts({ role: role({ permission: 'ask' }), init: init({ permissionMode: 'default' }) })).toEqual([]);
    expect(facts({ role: role({ permission: 'ask' }), init: init({ permissionMode: 'acceptEdits' }) }).join()).toContain('expected "default", CLI reports "acceptEdits"');
    // the run was switched live to Automatic: the next init reports acceptEdits and that is the truth now
    expect(facts({ role: role({ permission: 'ask' }), mode: 'automatic', init: init({ permissionMode: 'acceptEdits' }) })).toEqual([]);
    expect(facts({ role: role({ permission: 'readOnly' }), mode: 'bypass', init: init({ permissionMode: 'plan' }) }).join()).toContain('expected "acceptEdits", CLI reports "plan"');
  });
});

describe('credential in use (A2 auth modes)', () => {
  it('subscription with the login is clean', () => expect(checkCredential('subscription', 'none', false)).toEqual({ mode: 'subscription', source: 'none' }));
  it('subscription that ends up on an API key warns', () => {
    expect(checkCredential('subscription', 'ANTHROPIC_API_KEY', false).warning).toContain('API billing');
    expect(checkCredential('subscription', 'apiKeyHelper', false).warning).toBeTruthy();
  });
  it('a stray ANTHROPIC_API_KEY that was removed is reported', () => {
    expect(checkCredential('subscription', 'none', true).warning).toContain('removed');
  });
  it('apiKey mode must report the key source', () => {
    expect(checkCredential('apiKey', 'ANTHROPIC_API_KEY', false).warning).toBeUndefined();
    expect(checkCredential('apiKey', 'none', false).warning).toContain('instead of ANTHROPIC_API_KEY');
  });
});

describe('ToolIntent classification (providers-plan 5.4 rows)', () => {
  it('Bash passes the raw command through, unparsed', () => {
    expect(intentFor('Bash', { command: '/usr/bin/git push origin HEAD', description: 'push' })).toMatchObject({ class: 'exec', rawCommand: '/usr/bin/git push origin HEAD', tool: 'Bash' });
    expect(intentFor('Bash', { command: 'sh -c "git commit -m x"' }).rawCommand).toBe('sh -c "git commit -m x"');
  });
  it.each([['Edit', { file_path: '/r/a.ts' }], ['Write', { file_path: '/r/.husky/pre-commit' }], ['MultiEdit', { file_path: '/r/b' }], ['NotebookEdit', { notebook_path: '/r/n.ipynb' }]])('%s is a write with paths', (tool, input) => {
    const i = intentFor(tool, input);
    expect(i.class).toBe('write');
    expect(i.paths).toHaveLength(1);
  });
  it.each(['Read', 'Grep', 'Glob', 'LS'])('%s is a read', (tool) => expect(intentFor(tool, { path: '/r' }).class).toBe('read'));
  it('WebFetch carries the url, WebSearch is net without one', () => {
    expect(intentFor('WebFetch', { url: 'https://example.com/x' })).toMatchObject({ class: 'net', url: 'https://example.com/x' });
    expect(intentFor('WebSearch', { query: 'q' })).toMatchObject({ class: 'net' });
  });
  it('MCP tools carry the server, subagents the type and parent', () => {
    expect(intentFor('mcp__docs__search', {})).toMatchObject({ class: 'mcp', server: 'docs', tool: 'mcp__docs__search' });
    expect(intentFor('Agent', { subagent_type: 'reviewer' }, 'tp')).toMatchObject({ class: 'other', subagentType: 'reviewer', parentToolId: 'tp' });
  });
  it('the actor and the Agent facts are only there when there is something to say', () => {
    expect(intentFor('Bash', { command: 'ls' })).not.toHaveProperty('actor');
    expect(intentFor('Bash', { command: 'ls' }, undefined, { agentId: 'a1', role: 'researcher' })).toMatchObject({ actor: { agentId: 'a1', role: 'researcher' } });
    expect(intentFor('Agent', { subagent_type: 'r', model: 'opus', isolation: 'worktree', run_in_background: true })).toMatchObject({ isolation: 'worktree', subagentFlags: { hasModel: true, background: true, subagentType: 'r' } });
    expect(intentFor('Agent', { subagent_type: 'r' })).toMatchObject({ subagentFlags: { hasModel: false } });
    expect(intentFor('Agent', { subagent_type: 'r' }).subagentFlags).not.toHaveProperty('background');
  });
  it('unknown tools are "other" (Rust asks)', () => {
    expect(intentFor('SomethingNew', {}).class).toBe('other');
    expect(intentFor('Bash', undefined).rawCommand).toBe('');
  });
  it('tool kinds follow the ACP taxonomy', () => {
    expect([toolKind('Read'), toolKind('Grep'), toolKind('Edit'), toolKind('Bash'), toolKind('WebFetch'), toolKind('mcp__a__b'), toolKind('Agent')]).toEqual(['read', 'search', 'edit', 'exec', 'fetch', 'mcp', 'other']);
  });
});

describe('intent parity with the Rust mapping (fixtures/intent-cases.json)', () => {
  const cases = JSON.parse(readFileSync(new URL('../../packages/protocol/fixtures/intent-cases.json', import.meta.url), 'utf8')) as { tool: string; input: unknown; intent: Record<string, unknown> }[];
  const norm = (v: unknown) => (v === null || v === '' ? undefined : v);
  it.each(cases.map((c) => [`${c.tool} ${JSON.stringify(c.input).slice(0, 50)}`, c] as const))('%s', (_n, c) => {
    const got = intentFor(c.tool, c.input) as Record<string, unknown>;
    for (const k of ['class', 'rawCommand', 'url', 'server', 'subagentType', 'isolation']) expect(norm(got[k]), k).toEqual(norm(c.intent[k]));
    const flags = (v: unknown) => (v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null)) : v);
    expect(flags(got.subagentFlags), 'subagentFlags').toEqual(flags(c.intent.subagentFlags));
    expect(got.paths ?? [], 'paths').toEqual(c.intent.paths ?? []);
  });
  it('Monitor runs a shell string, so it is judged like Bash; an unknown tool shows a redacted copy of its input', () => {
    expect(intentFor('Monitor', { command: 'cp /usr/local/bin/git ./gg', description: 'watch' })).toMatchObject({ class: 'exec', rawCommand: 'cp /usr/local/bin/git ./gg', summary: 'watch' });
    expect(toolKind('Monitor')).toBe('exec');
    const i = intentFor('RemoteTrigger', { action: 'run', password: 'hunter2222' });
    expect(i).toMatchObject({ class: 'other' });
    expect(i.summary).toContain('RemoteTrigger');
    expect(i.summary).toContain('"action":"run"');
    expect(i.summary).not.toContain('hunter2222');
  });
});

describe('inline settings overlay', () => {
  it('carries deny rules for commit/push, stage-all, gh merge and protected paths, and no hooks or plugins', () => {
    const o = settingsOverlay({ shimDir: '/shim' }) as { hooks: object; enabledPlugins: object; permissions: { deny: string[] } };
    expect(o.hooks).toEqual({});
    expect(o.enabledPlugins).toEqual({});
    for (const r of ['Bash(git commit:*)', 'Bash(git push:*)', 'Bash(gh pr merge*)', 'Edit(**/.husky/**)', 'Write(**/.git/**)', 'Edit(/shim/**)']) expect(o.permissions.deny).toContain(r);
    expect(DENY_RULES.length).toBeGreaterThan(15);
  });
  it('the deny-rule layer can be ablated (enforcement suite only)', () => {
    const o = settingsOverlay({ shimDir: '/shim' }, false) as { permissions: { deny: string[] } };
    expect(o.permissions.deny).toEqual([]);
  });
  it('disables Claude Remote Control on every run, also with the deny rules ablated; only the explicit Mac-side opt-in lifts it', () => {
    expect(settingsOverlay({ shimDir: '/shim' })).toMatchObject({ disableRemoteControl: true });
    expect(settingsOverlay({ shimDir: '/shim' }, false)).toMatchObject({ disableRemoteControl: true });
    expect(settingsOverlay({}, true)).toMatchObject({ disableRemoteControl: true });
    expect(settingsOverlay({ shimDir: '/shim' }, true, true)).not.toHaveProperty('disableRemoteControl');
  });
});

describe('extra directories travel in the inline settings, never as the --add-dir flag', () => {
  it('puts them into permissions.additionalDirectories next to the deny rules', () => {
    const o = settingsOverlay({ shimDir: '/shim' }, true, false, ['/repos/admin', '/repos/backend']) as { permissions: { deny: string[]; additionalDirectories?: string[] } };
    expect(o.permissions.additionalDirectories).toEqual(['/repos/admin', '/repos/backend']);
    expect(o.permissions.deny).toContain('Bash(git commit:*)');
  });
  it('leaves the key out when there are none', () => {
    expect(settingsOverlay({}, true).permissions).not.toHaveProperty('additionalDirectories');
  });
});

describe('isolationLeak (fail-closed init check)', () => {
  it('is null for the CLI built-in plugins only', () => expect(isolationLeak(init(), [])).toBeNull());
  it('names a user plugin loaded from the plugin cache', () => {
    const r = isolationLeak(init({ plugins: [{ name: 'token-optimizer', path: '/Users/x/.claude/plugins/cache/t/5.4.3' }, { name: 'agents-md', path: 'builtin' }] }), []);
    expect(r).toContain('token-optimizer');
    expect(r).toContain('isolation leaked');
  });
  it('names MCP servers that the IDE did not ask for, and accepts the ones it did', () => {
    expect(isolationLeak(init({ mcp_servers: [{ name: 'sentry', status: 'connected' }] }), [])).toContain('sentry');
    expect(isolationLeak(init({ mcp_servers: [{ name: 'ide-mongo', status: 'connected' }] }), ['ide-mongo'])).toBeNull();
  });
});

describe('the git shim is not optional for a session that can edit (edit, automatic, bypass)', () => {
  const spec = (permission: ResolvedRole['permission'], env: Record<string, unknown>) => ({
    agentId: 'a1', provider: 'claude', role: { name: 'dev', model: 'claude-haiku-4-5-20251001', permission }, cwd: '/tmp', addDirs: [], env: { claudeBin: '/nonexistent/claude', ...env }, mcp: {}, auth: { mode: 'subscription', key: null },
  }) as never;
  it.each(['edit', 'automatic', 'bypass'] as const)('refuses to open a %s session without shimDir, before anything is spawned', async (mode) => {
    await expect(ClaudeSession.open(spec(mode, {}), {} as never, {} as never, {} as never)).rejects.toThrow(/shimDir is required/);
  });
  it.each(['readOnly', 'ask'] as const)('does not insist for a %s session (it fails later, on the missing binary, not on the shim)', async (mode) => {
    await expect(ClaudeSession.open(spec(mode, {}), { emit() {} } as never, {} as never, {} as never)).rejects.not.toThrow(/shimDir is required/);
  });
  it('still refuses a mode the Claude adapter has no SDK mapping for, before anything is spawned', async () => {
    await expect(ClaudeSession.open(spec('auto' as never, { shimDir: '/shim' }), {} as never, {} as never, {} as never)).rejects.toThrow(/not offered for Claude/);
  });
});

describe('plansDirectory (where the CLI keeps its plan notes)', () => {
  it('is set from planDir and absent without one (the CLI would write into the real ~/.claude/plans)', () => {
    expect(settingsOverlay({ shimDir: '/shim' }, true, false, [], '/ide/state/plans/a1')).toMatchObject({ plansDirectory: '/ide/state/plans/a1' });
    expect(settingsOverlay({ shimDir: '/shim' })).not.toHaveProperty('plansDirectory');
  });
});
