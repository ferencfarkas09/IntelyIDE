// What differs between ACP agents is data, not code: the command, how to find out whether it is installed, which environment
// variable carries an API key. Everything else is negotiated through initialize and the config options.
import type { PermissionMode } from '../../types.js';

export interface AcpProfile {
  /** Provider id as the registry and the roles know it. */
  id: string;
  name: string;
  /** Bare command name, looked up on the login-shell PATH (or an absolute path). */
  command: string;
  versionArgs: string[];
  /** Launch arguments; the role mode is passed in case an agent needs a flag for it. */
  args(mode: PermissionMode): string[];
  /** Variable that carries the key in apiKey/token mode; the key never goes into argv. */
  keyEnv?: string;
  /** ACP auth method id to select in apiKey mode when the agent lists it (no credential travels in the call). */
  keyAuthMethod?: string;
  /** What to tell the user when the agent says it is not signed in. */
  loginHint: string;
}

/** A user-confirmed command line ("Add another ACP agent"): nothing is assumed about the agent. */
export const GENERIC: AcpProfile = {
  id: 'acp',
  name: 'ACP agent',
  command: '',
  versionArgs: ['--version'],
  args: () => [],
  loginHint: 'Sign in with the agent\'s own CLI in a terminal, then try again.',
};

/**
 * Gemini CLI. `gemini --acp` per the 5b plan; older builds called the flag `--experimental-acp` (spike item). The read-only mode
 * is chosen after session/new from the modes the agent really offers instead of a launch flag nobody has verified under --acp.
 */
export const GEMINI: AcpProfile = {
  id: 'gemini',
  name: 'Gemini CLI',
  command: 'gemini',
  versionArgs: ['--version'],
  args: () => ['--acp'],
  keyEnv: 'GEMINI_API_KEY',
  keyAuthMethod: 'gemini-api-key',
  loginHint: 'Run `gemini` once in a terminal and sign in (or choose an API key), then try again.',
};

/**
 * Profiles below were never run against the real program (none is installed here): the launch flags are the vendors' documented
 * ones and the Rust host always sends the command line the user confirmed, which overrides `command`/`args`. Each stays `weak`.
 */
export const COPILOT: AcpProfile = {
  id: 'copilot',
  name: 'GitHub Copilot CLI',
  command: 'copilot',
  versionArgs: ['--version'],
  args: () => ['--acp', '--stdio'],
  loginHint: 'Run `copilot` once in a terminal and sign in with /login (a GitHub Copilot plan is needed), then try again.',
};

export const OPENCODE: AcpProfile = {
  id: 'opencode',
  name: 'OpenCode',
  command: 'opencode',
  versionArgs: ['--version'],
  args: () => ['acp'],
  loginHint: 'Run `opencode auth login` in a terminal, then try again.',
};

export const GOOSE: AcpProfile = {
  id: 'goose',
  name: 'Goose',
  command: 'goose',
  versionArgs: ['--version'],
  args: () => ['acp'],
  loginHint: 'Run `goose configure` in a terminal to set up a model, then try again.',
};

export const QWEN: AcpProfile = {
  id: 'qwen',
  name: 'Qwen Code',
  command: 'qwen',
  versionArgs: ['--version'],
  args: () => ['--acp'],
  loginHint: 'Run `qwen` once in a terminal and sign in, then try again.',
};

export const PROFILES: Record<string, AcpProfile> = { acp: GENERIC, gemini: GEMINI, copilot: COPILOT, opencode: OPENCODE, goose: GOOSE, qwen: QWEN };
