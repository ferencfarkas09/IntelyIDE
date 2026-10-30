// Child environment builder (providers-plan 4.2): keep what the CLI needs, drop everything that identifies the host
// session or carries credentials, and add only the single chosen auth variable. Only names are ever reported.
import path from 'node:path';
import type { AuthMode, SessionEnv } from './types.js';

/** The only variables a child gets (mirrors `scrub_env` in crates/agent_host/src/config.rs): an allow-list, because a
 * deny-list misses DATABASE_URL, *_KEY, SENTRY_DSN, GIT_ASKPASS and whatever is named next. */
const ALLOWED = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMPDIR', 'LANG', 'NVM_DIR', 'GNUPGHOME', 'CLAUDE_CONFIG_DIR', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']);
const allowed = (k: string) => ALLOWED.has(k) || k.startsWith('LC_');

/** Kept on Windows only, in addition to the portable list (mirrors `WINDOWS_ENV` in crates/core/src/env.rs): Node and its
 * crypto read SystemRoot, `.cmd` shims need ComSpec and PATHEXT, the CLIs keep their data under USERPROFILE and APPDATA.
 * None of them carries a credential. */
export const WINDOWS_ENV = [
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'CommonProgramFiles', 'OS', 'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS', 'CLAUDE_CODE_GIT_BASH_PATH',
] as const;
/** ASCII-only upper case, as Rust's `eq_ignore_ascii_case`: `ſystemRoot` or `ProgramFıles` never fold into a kept name. */
const asciiUpper = (s: string) => s.replace(/[a-z]/g, (c) => c.toUpperCase());
const WINDOWS_BY_UPPER = new Map<string, string>([['PATH', 'PATH'], ...WINDOWS_ENV.map((n) => [asciiUpper(n), n] as [string, string])]);

/** The name under which `k` survives an allow-list, or null. On Windows names match without (ASCII) case (`Path` arrives as
 * `PATH`) and the platform list is added. `isAllowed` is the portable list of the caller. */
export function allowedName(k: string, isAllowed: (k: string) => boolean, windows = process.platform === 'win32'): string | null {
  if (windows) {
    const n = WINDOWS_BY_UPPER.get(asciiUpper(k));
    if (n) return n;
  }
  return isAllowed(k) ? k : null;
}

/** Mirrors `windows_env_value_ok` (crates/core/src/env.rs): CLAUDE_CODE_GIT_BASH_PATH only as an absolute local path to a bash.exe. */
export function windowsEnvValueOk(name: string, value: string): boolean {
  if (name !== 'CLAUDE_CODE_GIT_BASH_PATH') return true;
  const drive = /^[A-Za-z]:[\\/]/.test(value);
  const file = value.split(/[\\/]/).pop() ?? '';
  return drive && asciiUpper(file) === 'BASH.EXE' && !value.includes('..') && !value.slice(2).includes(':');
}

/** Mirrors `fold_env` (crates/core/src/env.rs): the kept name of each variable, decided the same way on every run (the exact
 * spelling wins over another, `PATH` over `Path`, else the first in sorted key order); refused values are dropped. */
export function foldEnv(vars: Iterable<[string, string]>, nameOf: (k: string) => string | null): { env: Record<string, string>; scrubbed: string[] } {
  const env: Record<string, string> = {};
  const exact = new Set<string>();
  const scrubbed: string[] = [];
  for (const [k, v] of [...vars].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const name = nameOf(k);
    if (!name || !windowsEnvValueOk(name, v)) { scrubbed.push(k); continue; }
    if (name in env && (exact.has(name) || k !== name)) continue;
    env[name] = v;
    if (k === name) exact.add(name);
  }
  return { env, scrubbed };
}

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
  opts: { addDirs: boolean; base?: NodeJS.ProcessEnv; windows?: boolean } = { addDirs: false },
): BuiltEnv {
  const base = spec.vars ?? opts.base ?? process.env;
  const strings = Object.entries(base).filter((e): e is [string, string] => typeof e[1] === 'string');
  const { env, scrubbed } = foldEnv(strings, (k) => allowedName(k, allowed, opts.windows));
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
