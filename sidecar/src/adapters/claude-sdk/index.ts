// claude-sdk adapter (A1/A2): Agent SDK driving the user's own installed claude CLI. Loaded lazily, only when enabled.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildChildEnv } from '../../env.js';
import { loadSdk, SdkError } from '../../sdk.js';
import type { AgentProvider, DetectContext, Detection, ModelInfo, ProviderCaps } from '../../types.js';
import { staticCaps, toModelInfo } from './caps.js';
import type { CliModel } from './facts.js';
import { ClaudeSession } from './session.js';
import { settingsOverlay } from './settings.js';

const run = promisify(execFile);

const provider: AgentProvider = {
  id: 'claude',
  kind: 'sdk',

  /** Installed + version only; auth state needs a session (init reports apiKeySource), so it stays "unknown" here. */
  async detect(ctx: DetectContext): Promise<Detection> {
    if (!ctx.claudeBin) return { installed: false, auth: 'unknown' };
    try {
      const { stdout } = await run(ctx.claudeBin, ['--version'], { timeout: 5000, env: buildChildEnv({}, { mode: 'subscription', key: null }).env });
      const found: Detection = { installed: true, version: stdout.trim().split(/\s+/)[0], path: ctx.claudeBin, auth: 'unknown' };
      // The CLI is there, so this is never "not installed"; a missing/unverified SDK is a prefixed message (sdk_missing: ...) for the card.
      try { await loadSdk(); } catch (e) { if (e instanceof SdkError) return { ...found, message: e.message }; throw e; }
      return found;
    } catch {
      return { installed: false, auth: 'unknown' };
    }
  },

  capabilities(): ProviderCaps { return staticCaps(); },

  /** Model catalog from a short-lived, isolated CLI (initialize makes no model call). */
  async listModels(ctx: DetectContext): Promise<ModelInfo[]> {
    if (!ctx.claudeBin) return [];
    const { query } = await loadSdk();
    const never = (async function* () { await new Promise(() => {}); })();
    const q = query({
      prompt: never,
      options: {
        pathToClaudeCodeExecutable: ctx.claudeBin,
        settingSources: [], strictMcpConfig: true, mcpServers: {},
        settings: settingsOverlay({}) as never,
        env: buildChildEnv({}, { mode: 'subscription', key: null }).env,
      },
    });
    try {
      const ir = await q.initializationResult();
      return (ir.models as CliModel[]).map(toModelInfo);
    } finally {
      q.close();
    }
  },

  open: (spec, sink, policy, host) => ClaudeSession.open(spec, sink, policy, host),
};

export default provider;
export { ClaudeSession };
