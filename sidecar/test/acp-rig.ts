// Test rig for the ACP adapter: the scripted fake agent, a fixture repo with a bare remote, a stand-in policy and an event collector.
// Everything lives under mkdtemp; no user repo, no network, no credential.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import acpProvider, { makeAcpProvider } from '../src/adapters/acp/index.js';
import { GEMINI } from '../src/adapters/acp/profiles.js';
import { SeqSink, TurnGuard, checkInvariants } from '../src/turn.js';
import type { AcpLaunch, PermissionMode, PolicyClient, PolicyDecision, PolicyRequest, WireEvent } from '../src/types.js';
import { makePolicy } from '../../tests/fakes/hardstop-policy.mjs';

export const FAKE = path.resolve(__dirname, '../tests/fakes/fake-acp-agent.mjs');
export const SCRIPTS = path.resolve(__dirname, '../tests/fakes/acp-scripts');
export const GIT = ['/usr/bin/git', '/usr/local/bin/git'].find((p) => fs.existsSync(p))!;
export const GENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } as NodeJS.ProcessEnv;
export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const dirs: string[] = [];
export const tmp = (prefix = 'intely-acp-') => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); dirs.push(d); return d; };
export const cleanTmp = () => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); };

/** Stand-in for the generated allow-list shim (crates/agent_gate shim.rs): read-only verbs pass, everything else exits 126. */
export function allowListShim(): string {
  const dir = path.join(tmp('intely-acp-shim-'), 'git-shim');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\ncase "$1" in status|log|diff|show|rev-parse|ls-files|ls-tree|cat-file|blame|describe|grep) exec ${GIT} "$@";; esac\necho "INTELY-GIT-SHIM: refused git $*" >&2\nexit 126\n`, { mode: 0o755 });
  return dir;
}

export const git = (cwd: string, ...a: string[]) => execFileSync(GIT, a, { cwd, env: GENV, encoding: 'utf8' }).trim();

/** A throw-away repo with one commit and a bare remote called origin (a local path, never a real URL). */
export function fixtureRepo() {
  const root = tmp('intely-acp-fx-');
  const repo = path.join(root, 'work');
  const remote = path.join(root, 'remote.git');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'fx@example.invalid');
  git(repo, 'config', 'user.name', 'fixture');
  fs.writeFileSync(path.join(repo, 'README.md'), 'line1\nline2\nline3\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(root, 'clone', '-q', '--bare', repo, remote);
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'main'); // fixture setup, before any agent exists
  const snap = () => ({
    head: git(repo, 'rev-parse', 'HEAD'),
    commits: git(repo, 'rev-list', '--count', 'HEAD'),
    refs: git(repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
    remote: execFileSync(GIT, ['--git-dir', remote, 'for-each-ref', '--format=%(refname) %(objectname)'], { env: GENV, encoding: 'utf8' }).trim(),
  });
  return { root, repo, remote, snap };
}

export const allowAll: PolicyClient = { decide: async () => ({ decision: 'allow', by: 'saved' }) };
export function hardStopPolicy(log: any[] = []): PolicyClient {
  const f = makePolicy({ log });
  return { decide: async (req: PolicyRequest) => f(req) as PolicyDecision };
}

export interface RigOpts {
  script: string;
  permission?: PermissionMode;
  policy?: PolicyClient;
  cwd?: string;
  addDirs?: string[];
  shim?: boolean;
  acp?: Partial<AcpLaunch>;
  role?: Partial<{ model: string; effort: string }>;
  resume?: string;
  /** a script path outside the shared directory */
  scriptPath?: string;
  /** run as the gemini profile (it has an API-key variable) with this key */
  apiKey?: string;
}

export async function rig(o: RigOpts) {
  const events: WireEvent[] = [];
  const seq = new SeqSink((e) => events.push(e));
  const guard = new TurnGuard(seq);
  const cwd = o.cwd ?? tmp('intely-acp-cwd-');
  const home = tmp('intely-acp-home-');
  const log = path.join(tmp('intely-acp-log-'), 'fake.log');
  const pids: number[] = [];
  const session = await (o.apiKey ? makeAcpProvider(GEMINI) : acpProvider).open(
    {
      agentId: 'a1', provider: 'acp', role: { name: 'r', model: 'default', permission: o.permission ?? 'readOnly', ...(o.role ?? {}) }, cwd, addDirs: o.addDirs ?? [],
      env: { vars: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home }, ...(o.shim ? { shimDir: allowListShim() } : {}) } as never,
      mcp: {}, auth: o.apiKey ? { mode: 'apiKey', key: o.apiKey } : { mode: 'subscription', key: null }, ...(o.resume ? { resume: { nativeId: o.resume } } : {}),
      acp: {
        command: process.execPath, args: [FAKE, o.scriptPath ?? path.join(SCRIPTS, `${o.script}.jsonl`)], writeAllowed: o.permission !== undefined && o.permission !== 'readOnly',
        env: { FAKE_ACP_LOG: log, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, initTimeoutMs: 4000, termMs: 400, ...(o.acp ?? {}),
      },
    },
    guard, o.policy ?? hardStopPolicy(), { registerPid: (p) => pids.push(p) },
  );
  const until = async (pred: () => boolean, ms = 6000) => {
    const t0 = Date.now();
    while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timeout; events: ${events.map((e) => e.kind).join(',')}`); await wait(15); }
  };
  const turnEnded = () => events.some((e) => e.kind === 'turn.end');
  /** One full turn: begin, prompt, wait for the single turn.end. */
  const turn = async (text = 'go', ms = 8000) => {
    const before = events.filter((e) => e.kind === 'turn.end').length;
    guard.beginTurn();
    session.prompt({ text });
    await until(() => events.filter((e) => e.kind === 'turn.end').length > before, ms);
  };
  const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const replies = () => Object.fromEntries(lines().filter((l) => l.dir === 'reply').map((l) => [l.m.name, l.m.reply]));
  const received = (method: string) => lines().filter((l) => l.dir === 'in' && l.m.method === method).map((l) => l.m);
  const grandchildren = () => lines().filter((l) => l.dir === 'fake' && l.m.fake === 'grandchild').map((l) => l.m.pid as number);
  const text = () => events.filter((e) => e.kind === 'text.delta').map((e: any) => e.text).join('');
  const kinds = () => events.map((e) => e.kind);
  const violations = () => checkInvariants(events as never);
  return { session, events, guard, seq, cwd, pids, until, turn, turnEnded, lines, replies, received, grandchildren, text, kinds, violations, log };
}

export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
