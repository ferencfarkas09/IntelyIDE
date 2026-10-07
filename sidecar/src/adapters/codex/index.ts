// codex adapter (A5): `codex app-server` over stdio JSON-RPC, driving the user's own installed, unmodified codex CLI.
// Loaded lazily, only when enabled. Auth is only detected (`codex login status`); the IDE never starts a login or stores a token.
import { existsSync } from 'node:fs';
import type { AgentProvider, DetectContext, Detection, ModelInfo, ProviderCaps } from '../../types.js';
import { modelsOf, staticCaps } from './caps.js';
import { buildCodexEnv } from './config.js';
import { cliVersion, loginStatus, startServer } from './proc.js';
import { CodexSession } from './session.js';
import { cmpVersion, MIN_VERSION } from './wire.js';

const binOf = (ctx: DetectContext): string | undefined => {
  const explicit = (ctx as { codexBin?: string }).codexBin;
  if (explicit) return explicit;
  for (const d of (process.env.PATH ?? '').split(':')) if (d && existsSync(`${d}/codex`)) return `${d}/codex`;
  return undefined;
};
const baseEnv = () => buildCodexEnv({}, { mode: 'subscription', key: null }).env;

const provider: AgentProvider = {
  id: 'codex',
  kind: 'cli',

  /** Installed + version + stored login only. `login status` does not prove the token still refreshes: a 401 shows up as an auth error on the first turn. */
  async detect(ctx: DetectContext): Promise<Detection> {
    const bin = binOf(ctx);
    if (!bin) return { installed: false, auth: 'unknown', message: 'codex not found on PATH' };
    const env = baseEnv();
    const version = await cliVersion(bin, env);
    if (!version) return { installed: false, auth: 'unknown', path: bin, message: '`codex --version` failed' };
    const login = await loginStatus(bin, env);
    return {
      installed: true, path: bin, version, versionOk: cmpVersion(version, MIN_VERSION) >= 0,
      auth: login.loggedIn ? 'ok' : 'needsLogin',
      ...(login.loggedIn ? {} : { message: 'run `codex login` in a terminal' }),
    };
  },

  capabilities(): ProviderCaps { return staticCaps(); },

  /** model/list from a short-lived app-server (no model call). */
  async listModels(ctx: DetectContext): Promise<ModelInfo[]> {
    const bin = binOf(ctx);
    if (!bin) return [];
    const server = startServer(bin, ['app-server', '--listen', 'stdio://'], baseEnv(), process.cwd(), {});
    try {
      await server.rpc.request('initialize', { clientInfo: { name: 'intely-ide', version: '0.0.0' } }, 15_000);
      server.rpc.notify('initialized');
      const r = await server.rpc.request('model/list', { limit: 100 }, 15_000);
      return modelsOf(r);
    } finally {
      await server.stop(1500);
    }
  },

  open: (spec, sink, policy, host) => CodexSession.open(spec, sink, policy, host),
};

export default provider;
export { CodexSession };
