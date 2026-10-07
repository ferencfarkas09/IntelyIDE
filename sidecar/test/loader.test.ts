import { describe, expect, it, vi } from 'vitest';
import { Loader, ProviderDisabledError, type Registry } from '../src/loader.js';
import type { AgentProvider } from '../src/types.js';

const fake = (id: string): AgentProvider => ({ id, kind: 'cli', detect: async () => ({ installed: true, auth: 'ok' }), capabilities: () => ({}) as never, listModels: async () => [], open: async () => ({}) as never });

function spyRegistry() {
  const calls: string[] = [];
  const registry: Registry = {
    claude: vi.fn(async () => { calls.push('claude'); return { default: fake('claude') }; }),
    mock: vi.fn(async () => { calls.push('mock'); return { default: fake('mock') }; }),
  };
  return { registry, calls };
}

describe('zero cost when providers are off (providers-plan 1.3)', () => {
  it('imports nothing at construction', () => {
    const { registry, calls } = spyRegistry();
    const l = new Loader(registry, ['claude', 'mock']);
    expect(calls).toEqual([]);
    expect(l.loaded()).toEqual([]);
  });

  it('with providers off no adapter module is ever loaded, even when asked', async () => {
    const { registry, calls } = spyRegistry();
    const l = new Loader(registry, []);
    await expect(l.load('claude')).rejects.toBeInstanceOf(ProviderDisabledError);
    await expect(l.load('mock')).rejects.toBeInstanceOf(ProviderDisabledError);
    expect(calls).toEqual([]);
  });

  it('loads only the enabled adapter, once, and only on first use', async () => {
    const { registry, calls } = spyRegistry();
    const l = new Loader(registry, ['mock']);
    await Promise.all([l.load('mock'), l.load('mock')]);
    await l.load('mock');
    expect(calls).toEqual(['mock']);
    expect(l.loaded()).toEqual(['mock']);
    await expect(l.load('claude')).rejects.toThrow('not enabled');
    expect(calls).toEqual(['mock']);
  });

  it('retries after a failed import', async () => {
    let n = 0;
    const l = new Loader({ claude: async () => { if (n++ === 0) throw new Error('boom'); return { default: fake('claude') }; } }, ['claude']);
    await expect(l.load('claude')).rejects.toThrow('boom');
    expect((await l.load('claude')).id).toBe('claude');
  });
});
