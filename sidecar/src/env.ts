// Child environment builder (providers-plan 4.2): keep what the CLI needs, drop everything that identifies the host
// session or carries credentials, and add only the single chosen auth variable. Only names are ever reported.
import path from 'node:path';
import type { AuthMode, SessionEnv } from './types.js';

/** The only variables a child gets (mirrors `scrub_env` in crates/agent_host/src/config.rs): an allow-list, because a
 * deny-list misses DATABASE_URL, *_KEY, SENTRY_DSN, GIT_ASKPASS and whatever is named next. */
const ALLOWED = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMPDIR', 'LANG', 'NVM_DIR', 'GNUPGHOME', 'CLAUDE_CONFIG_DIR', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']);
const allowed = (k: string) => ALLOWED.has(k) || k.startsWith('LC_');

export interface BuiltEnv {
  env: Record<string, string>;
  /** Names that were removed (never values). */
  scrubbed: string[];
  /** Names that were added on purpose. */
  added: string[];
}

export function buildChildEnv(
  spec: SessionEnv,
  auth: { mode: AuthMode; key: string | null },
  opts: { addDirs: boolean; base?: NodeJS.ProcessEnv } = { addDirs: false },
): BuiltEnv {
  const base = spec.vars ?? opts.base ?? process.env;
  const env: Record<string, string> = {};
  const scrubbed: string[] = [];
  for (const [k, v] of Object.entries(base)) {
    if (typeof v !== 'string') continue;
    if (!allowed(k)) { scrubbed.push(k); continue; }
    env[k] = v;
  }
  const added: string[] = [];
  const add = (k: string, v: string) => { env[k] = v; added.push(k); };
  // Only the chosen credential survives: a stray ANTHROPIC_API_KEY must not flip a subscription session to API billing.
  if (auth.mode === 'apiKey' && auth.key) add('ANTHROPIC_API_KEY', auth.key);
  add('CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL', '1');
  // The IDE shows a run as turns: everything the model does happens inside one, so Stop and the "needs you" state can always reach it.
  // Without this the CLI backgrounds `Agent` calls and shell commands by default: the lead ends its turn ("waiting for the exploration
  // agent"), the sub-agent works on with no open turn (the run reads Done, Stop does nothing) and a plan card of the later wake-up turn
  // cannot be interrupted. Measured with CLI 2.1.289: `is_backgrounded` false and one `result` with the variable, true and two without.
  add('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', '1');
  if (opts.addDirs) add('CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD', '1');
  if (spec.shimDir) { env.PATH = `${spec.shimDir}${path.delimiter}${env.PATH ?? '/usr/bin:/bin'}`; added.push('PATH(shim)'); }
  return { env, scrubbed: scrubbed.sort(), added };
}
