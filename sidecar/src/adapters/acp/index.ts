// Generic ACP client adapter (A3, providers-plan 3.4): one codebase for every agent that speaks the Agent Client Protocol over stdio.
// `acp` takes a user-confirmed command line from session/start.acp; profiles (gemini) only add a default command and a few names.
import type { AgentProvider, DetectContext, Detection, ModelInfo, ProviderCaps } from '../../types.js';
import { computeCaps } from './caps.js';
import { readVersion, resolveCommand } from './launch.js';
import type { AcpProfile } from './profiles.js';
import { GENERIC } from './profiles.js';
import { AcpSession } from './session.js';

export function makeAcpProvider(profile: AcpProfile): AgentProvider {
  return {
    id: profile.id,
    kind: 'acp',

    /** Installed + version only (the login-shell PATH is searched); sign-in state needs a session, so it stays "unknown". No credential is read. */
    async detect(_ctx: DetectContext): Promise<Detection> {
      if (!profile.command) return { installed: false, auth: 'unknown', message: 'the command line comes from the user' };
      const bin = await resolveCommand(profile.command);
      if (!bin) return { installed: false, auth: 'unknown' };
      const version = await readVersion(bin, profile.versionArgs);
      return { installed: true, path: bin, ...(version ? { version } : {}), auth: 'unknown' };
    },

    /** Before a session only initialize-independent facts exist; the real matrix arrives in session.info (computed from initialize + config options). */
    capabilities(): ProviderCaps { return computeCaps(undefined); },

    /** The model list is a config option of a live session, so it arrives in session.info; there is no way to list it without starting the agent. */
    async listModels(): Promise<ModelInfo[]> { return []; },

    open: (spec, sink, policy, host) => AcpSession.open(profile, spec, sink, policy, host),
  };
}

export default makeAcpProvider(GENERIC);
export { AcpSession };
