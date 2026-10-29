// `models/list`: the live model list of the installed CLI for New run and Settings > Roles; never throws, no model call.
import { describe, expect, it } from 'vitest';
import { modelsOf, queryModels, type ModelsSdk } from '../src/models.js';

const sdkWith = (models: unknown, seen: Record<string, unknown>[] = []): ModelsSdk => ({
  query: ({ options }) => {
    seen.push(options);
    return { initializationResult: async () => ({ models }) as never, close: () => undefined } as never;
  },
});

describe('models/list', () => {
  it('maps the CLI catalog: ids, labels and the effort levels of each model', async () => {
    const seen: Record<string, unknown>[] = [];
    const reply = await queryModels({ env: { claudeBin: '/bin/claude' } }, {
      sdk: sdkWith([
        { value: 'claude-opus-5-5', displayName: 'Opus 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', supportsEffort: false },
      ], seen),
    });
    expect(reply).toEqual({ ok: true, models: [
      { id: 'claude-opus-5-5', label: 'Opus 5.5', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', effortLevels: [] },
    ] });
    // isolated like a session: no user settings, plugins, hooks or MCP servers
    expect(seen[0]).toMatchObject({ settingSources: [], strictMcpConfig: true, mcpServers: {}, pathToClaudeCodeExecutable: '/bin/claude' });
  });

  it('drops junk entries and answers errors instead of throwing', async () => {
    expect(modelsOf([{ value: '' }, null, { value: 'x'.repeat(200) }, { value: 'ok', displayName: 'Ok' }])).toEqual([{ id: 'ok', label: 'Ok', effortLevels: [] }]);
    expect(await queryModels({ env: {} })).toEqual({ error: 'claudeNotFound' });
    const failing: ModelsSdk = { query: () => ({ initializationResult: async () => { throw new Error('boom'); }, close: () => undefined }) as never };
    expect(await queryModels({ env: { claudeBin: '/bin/claude' } }, { sdk: failing })).toMatchObject({ error: 'failed', detail: 'boom' });
  });
});
