// Shared harness for the Codex adapter tests: the fake app-server as the `codex` binary, a TurnGuard-backed event collector
// and the same bookkeeping the sidecar host does around a turn.
import { execFileSync } from 'node:child_process';
import { afterAll, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexSession, type OpenOptions } from '../src/adapters/codex/session.js';
import { checkInvariants, SeqSink, TurnGuard } from '../src/turn.js';
import type { PermissionMode, PolicyClient, PolicyDecision, PolicyRequest, SessionSpec, WireEvent } from '../src/types.js';

export const FAKE = path.resolve(__dirname, '../tests/fakes/fake-codex-appserver.mjs');
const tmpDirs: string[] = [];
// Fixture directories are removed when the importing test file is done (registered at import, so it belongs to that file's suite).
afterAll(() => { for (const d of tmpDirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });
export const tmp = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `intely-codex-${p}-`)); tmpDirs.push(d); return d; };
export const until = async (pred: () => any, ms = 8000) => {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); }
  return pred();
};

/** Env that makes git inside a fixture independent of the machine (docs/safety.md): no global/system config, fixed identity. */
export const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_TERMINAL_PROMPT: '0' };
export const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();

export interface Fixture { repo: string; bare: string; shim: string; refs: () => string; cleanup: () => void }
/** A throw-away repo with one commit, a local bare remote (no network) and an empty shim directory. `base` moves it out of the system temp dir, which the Codex :workspace profile can write to. */
export function fixture(base?: string): Fixture {
  const root = base ? fs.mkdtempSync(path.join(base, 'fx-')) : tmp('fx');
  const bare = path.join(root, 'remote.git');
  const repo = path.join(root, 'repo');
  const shim = path.join(root, 'shim');
  fs.mkdirSync(shim);
  git(root, 'init', '-q', '--bare', bare);
  git(root, 'init', '-q', repo);
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'user.email', 't@t');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hi\n');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { commit: 'git commit --allow-empty -m viascript' } }));
  git(repo, 'add', 'a.txt', 'package.json');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '-q', 'origin', 'HEAD');
  const refs = () => `${git(repo, 'for-each-ref')}\n--bare--\n${git(bare, 'for-each-ref')}\n--status--\n${git(repo, 'status', '--porcelain')}`;
  return { repo, bare, shim, refs, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export const allow: PolicyClient = { decide: async () => ({ decision: 'allow', by: 'saved' }) };

export interface Rig {
  s: CodexSession;
  out: WireEvent[];
  guard: TurnGuard;
  log: () => any[];
  sent: () => any[];
  pids: number[];
  asked: PolicyRequest[];
  ended: () => number;
  turn: (text?: string) => void;
  done: (n?: number) => Promise<void>;
  kinds: () => string[];
  cleanup: () => Promise<void>;
}

export interface RigOptions {
  scenario?: string;
  mode?: PermissionMode;
  model?: string;
  effort?: string | null;
  policy?: PolicyClient | ((r: PolicyRequest) => PolicyDecision | Promise<PolicyDecision>);
  cwd?: string;
  env?: Record<string, string>;
  vars?: Record<string, string>;
  shimDir?: string | null;
  open?: OpenOptions;
  /** `session/start.acp` (the host's write switch). */
  acp?: SessionSpec['acp'];
  auth?: SessionSpec['auth'];
  resume?: string;
}

export async function rig(o: RigOptions = {}): Promise<Rig> {
  const out: WireEvent[] = [];
  const guard = new TurnGuard(new SeqSink((e) => out.push(e)));
  const logFile = path.join(tmp('log'), 'log.jsonl');
  const asked: PolicyRequest[] = [];
  const pol = o.policy ?? allow;
  const policy: PolicyClient = typeof pol === 'function' ? { decide: async (r) => { asked.push(r); return pol(r); } } : { decide: async (r) => { asked.push(r); return pol.decide(r); } };
  const mode = o.mode ?? 'readOnly';
  const pids: number[] = [];
  const spec: SessionSpec = {
    agentId: 'a1', provider: 'codex',
    role: { name: 'r', model: o.model ?? 'fake-luna', effort: o.effort === undefined ? 'high' : o.effort, permission: mode },
    cwd: o.cwd ?? process.cwd(), addDirs: [], mcp: {},
    env: { vars: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...(o.vars ?? {}) }, ...(o.shimDir === null ? {} : mode === 'readOnly' ? {} : { shimDir: o.shimDir ?? tmp('shim') }) },
    auth: o.auth ?? { mode: 'subscription', key: null },
    ...(o.acp ? { acp: o.acp } : {}),
    ...(o.resume ? { resume: { nativeId: o.resume } } : {}),
  };
  const extraEnv = { FAKE_CODEX_SCENARIO: o.scenario ?? 'text', FAKE_CODEX_LOG: logFile, ...GIT_ENV, ...(o.env ?? {}) };
  const s = await CodexSession.open(spec, guard, policy, { registerPid: (p) => pids.push(p) }, { bin: FAKE, allowWriter: true, ...(o.open ?? {}), extraEnv: { ...extraEnv, ...(o.open?.extraEnv ?? {}) } });
  const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const ended = () => out.filter((e) => e.kind === 'turn.end').length;
  return {
    s, out, guard, log, pids, asked, ended,
    sent: () => log().filter((l) => l.dir === 'out' && l.m.id !== undefined && l.m.method === undefined),
    turn: (text = 'go') => { guard.beginTurn(); guard.emit({ kind: 'user.message', messageId: 'u-1', text }); s.prompt({ text }); },
    done: async (n = 1) => { await until(() => ended() >= n); },
    kinds: () => out.map((e) => e.kind),
    cleanup: async () => { await s.close(); },
  };
}

export const invariantsOk = (r: Rig) => expect(checkInvariants(r.out)).toEqual([]);
/** The client's answers to server requests, as the fake saw them. */
export const answers = (r: Rig) => r.log().filter((l) => l.dir === 'in' && l.m.id >= 1000 && l.m.result).map((l) => l.m.result);
