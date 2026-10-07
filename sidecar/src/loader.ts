// Provider loader (providers-plan 1.3): an adapter module is import()ed only when it is enabled AND a session of
// that provider opens. With providers off nothing is loaded (zero cost, enforced by test/loader.test.ts).
import type { AgentProvider, ProviderId } from './types.js';

export type AdapterModule = { default: AgentProvider };
export type Registry = Record<ProviderId, () => Promise<AdapterModule>>;

export class ProviderDisabledError extends Error {
  constructor(id: string) { super(`provider "${id}" is not enabled`); }
}

export class Loader {
  private cache = new Map<ProviderId, Promise<AgentProvider>>();
  private done: ProviderId[] = [];

  constructor(private registry: Registry, readonly enabled: ProviderId[]) {}

  async load(id: ProviderId): Promise<AgentProvider> {
    if (!this.enabled.includes(id) || !this.registry[id]) throw new ProviderDisabledError(id);
    let p = this.cache.get(id);
    if (!p) {
      p = this.registry[id]().then((m) => { this.done.push(id); return m.default; });
      this.cache.set(id, p);
      p.catch(() => this.cache.delete(id));
    }
    return p;
  }

  /** Providers whose module was actually imported. */
  loaded(): ProviderId[] { return [...this.done]; }
}
