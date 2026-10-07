// What we tell Codex, and what we refuse to tell it (providers-plan 2.2, 3.3 A5). Pure functions, no I/O.
// Spike result ((design notes: providers-plan) "Codex spike results"): only the named permission profiles protect `.git`
// (`:workspace`); `sandbox: "workspace-write"` / `sandboxPolicy` leave `.git`, hooks and config writable. So the sandbox is
// always selected by profile, never by the legacy sandbox fields.
import path from 'node:path';
import type { AuthMode, PermissionMode, SessionEnv } from '../../types.js';

export type Profile = ':read-only' | ':workspace';
export interface CodexPolicy {
  /** The abstract mode this was derived from. */
  mode: PermissionMode;
  profile: Profile;
  /** Codex approval policy. Never `never`. */
  approval: 'on-request' | 'untrusted';
  /** Value for `session.started.effective.sandbox`. */
  sandboxLabel: string;
}

export function policyFor(mode: PermissionMode): CodexPolicy {
  switch (mode) {
    case 'readOnly': return { mode, profile: ':read-only', approval: 'on-request', sandboxLabel: 'read-only' };
    case 'edit': return { mode, profile: ':workspace', approval: 'on-request', sandboxLabel: 'workspace-write (.git read-only, network off)' };
    case 'ask': return { mode, profile: ':workspace', approval: 'untrusted', sandboxLabel: 'workspace-write (.git read-only, network off)' };
    // Codex never gets automatic or bypass (the UI hides them for it); this stays a refusal
    default: throw new Error(`permission "${mode}" is not offered for Codex (danger-full-access and the bypass flags are refused)`);
  }
}

const BAD_SANDBOX = new Set(['danger-full-access', 'dangerFullAccess', 'externalSandbox', ':danger-full-access']);

/** Last line of defence before anything is sent: throws on any parameter set that would widen the sandbox or skip approvals. */
export function assertSafeParams(p: Record<string, any>): void {
  const bad = (what: string): never => { throw new Error(`refused unsafe Codex parameter: ${what}`); };
  if (typeof p.sandbox === 'string') bad(`sandbox "${p.sandbox}" (profiles only)`);
  if (p.sandboxPolicy !== undefined && p.sandboxPolicy !== null) bad('sandboxPolicy (profiles only)');
  if (typeof p.permissions === 'string' && (BAD_SANDBOX.has(p.permissions) || (p.permissions !== ':workspace' && p.permissions !== ':read-only'))) bad(`permissions "${p.permissions}"`);
  if (p.approvalPolicy === 'never' || (p.approvalPolicy && typeof p.approvalPolicy === 'object')) bad('approvalPolicy never/granular');
  if (p.approvalsReviewer && p.approvalsReviewer !== 'user') bad(`approvalsReviewer "${p.approvalsReviewer}" (only the user/broker may approve)`);
  for (const k of ['dangerouslyBypassApprovalsAndSandbox', 'bypassApprovals', 'yolo']) if (p[k]) bad(k);
}

/** Argument vectors that must never reach the CLI (`exec`/`app-server` bypass flags and sandbox widening via -c). */
export function assertSafeArgs(args: readonly string[]): void {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^--(dangerously-|yolo|full-auto|add-dir|sandbox|ask-for-approval|profile)\b/.test(a) || a === '-s' || a === '-a' || a === '-p') throw new Error(`refused unsafe Codex argument: ${a}`);
    if (a === '-c' || a === '--config') {
      const kv = args[i + 1] ?? '';
      if (/^(sandbox_mode|approval_policy|default_permissions|permissions\b)/.test(kv) && !/^approval_policy="(on-request|untrusted)"$/.test(kv) && kv !== 'sandbox_mode="read-only"') throw new Error(`refused unsafe Codex -c override: ${kv}`);
    }
  }
}

/** Features that widen what the agent can reach (browser, computer use, plugins, hooks, sub-agents...). Disabled only if this CLI knows them: an unknown `--disable` aborts app-server. */
export const FEATURES_TO_DISABLE = [
  'apps', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'plugins', 'remote_plugin',
  'hooks', 'multi_agent', 'multi_agent_v2', 'in_app_browser', 'image_generation', 'goals', 'memories', 'tool_suggest',
] as const;

export function spawnArgs(knownFeatures?: ReadonlySet<string>): string[] {
  const args = [
    'app-server', '--listen', 'stdio://',
    // user config.toml cannot be ignored on app-server (only `exec` has --ignore-user-config): neutralize what it could widen
    '-c', 'notify=[]', '-c', 'mcp_servers={}', '-c', 'allow_login_shell=false', '-c', 'web_search="disabled"', '-c', 'analytics.enabled=false',
    '-c', 'shell_environment_policy.inherit="core"',
    '-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="read-only"',
  ];
  for (const f of FEATURES_TO_DISABLE) if (!knownFeatures || knownFeatures.has(f)) args.push('--disable', f);
  assertSafeArgs(args);
  return args;
}

// ---- environment (providers-plan 4.2): an allow-list, the single chosen credential, nothing else ----
const ALLOWED = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMPDIR', 'LANG', 'CODEX_HOME', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']);
const allowed = (k: string) => ALLOWED.has(k) || k.startsWith('LC_');
/** Credential-looking variables of other providers or of Codex itself, reported by name when they were dropped. */
const STRAY_KEYS = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY'];

export interface CodexEnv { env: Record<string, string>; scrubbed: string[]; added: string[]; strayKeys: string[] }

export function buildCodexEnv(spec: SessionEnv, auth: { mode: AuthMode; key: string | null }, base: NodeJS.ProcessEnv = process.env): CodexEnv {
  const src = spec.vars ?? base;
  const env: Record<string, string> = {};
  const scrubbed: string[] = [];
  for (const [k, v] of Object.entries(src)) {
    if (typeof v !== 'string') continue;
    if (!allowed(k)) { scrubbed.push(k); continue; }
    env[k] = v;
  }
  const added: string[] = [];
  if (auth.mode === 'apiKey' && auth.key) { env.CODEX_API_KEY = auth.key; added.push('CODEX_API_KEY'); }
  if (spec.shimDir) { env.PATH = `${spec.shimDir}${path.delimiter}${env.PATH ?? '/usr/bin:/bin'}`; added.push('PATH(shim)'); }
  return { env, scrubbed: scrubbed.sort(), added, strayKeys: STRAY_KEYS.filter((k) => scrubbed.includes(k)) };
}

/** Where `codex` is: an explicit `env.codexBin`, else the first executable on the PATH the child will get. */
export function codexBinOf(env: SessionEnv, exists: (p: string) => boolean): string | undefined {
  const explicit = (env as { codexBin?: string | null }).codexBin;
  if (explicit) return explicit;
  const dirs = (env.vars?.PATH ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) { const p = path.join(d, 'codex'); if (exists(p)) return p; }
  return undefined;
}

/** `low < medium < high < xhigh < max`: the highest level the model offers that is not above the request. */
export function clampEffort(want: string | null | undefined, offered: readonly string[]): { level: string | null; clamped: boolean } {
  if (!want) return { level: null, clamped: false };
  if (!offered.length) return { level: null, clamped: true };
  if (offered.includes(want)) return { level: want, clamped: false };
  const ladder = ['low', 'medium', 'high', 'xhigh', 'max'];
  const at = ladder.indexOf(want);
  for (let i = at - 1; i >= 0; i--) if (offered.includes(ladder[i])) return { level: ladder[i], clamped: true };
  return { level: offered[0], clamped: true };
}
