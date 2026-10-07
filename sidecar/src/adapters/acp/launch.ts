// Starting and stopping an ACP agent process: command lookup through the login-shell PATH, a scrubbed environment,
// its own process group (Rust kills the group if the sidecar dies, 5.6) and a tree walk for children that left the group.
import { execFile, type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildChildEnv } from '../../env.js';
import type { AuthMode, SessionEnv } from '../../types.js';

const run = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const isExec = (p: string) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };

/** Absolute path of `command`: as given, then the sidecar's own PATH, then the login shell's PATH (nvm, brew, ~/.local/bin). */
export async function resolveCommand(command: string, shell: string = process.env.SHELL || '/bin/zsh'): Promise<string | null> {
  if (command.includes('/')) return isExec(command) ? command : null;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && isExec(path.join(dir, command))) return path.join(dir, command);
  }
  if (!/^[A-Za-z0-9._+-]+$/.test(command)) return null; // never feed an arbitrary string to the shell
  try {
    const { stdout } = await run(shell, ['-ilc', `command -v ${command}`], { timeout: 6000, env: { HOME: process.env.HOME ?? '', USER: process.env.USER ?? '', PATH: '/usr/bin:/bin' } });
    const p = stdout.trim().split('\n').pop() ?? '';
    return p.startsWith('/') && isExec(p) ? p : null;
  } catch {
    return null;
  }
}

/** First dotted number in `--version` output; null when the binary does not answer. */
export async function readVersion(bin: string, args: string[] = ['--version']): Promise<string | null> {
  try {
    const { stdout } = await run(bin, args, { timeout: 5000, env: buildChildEnv({}, { mode: 'subscription', key: null }).env });
    return /\d+\.\d+(?:\.\d+)?(?:[-+.\w]*)?/.exec(stdout)?.[0] ?? stdout.trim().split('\n')[0] ?? null;
  } catch {
    return null;
  }
}

export interface LaunchEnv {
  env: Record<string, string>;
  /** Names removed from the base environment (never values). */
  scrubbed: string[];
}

/** The agent's environment: allow-listed base + the git shim first in PATH + exactly one credential variable in apiKey/token mode. */
export function agentEnv(env: SessionEnv, auth: { mode: AuthMode; key: string | null }, opts: { keyVar?: string; extra?: Record<string, string> } = {}): LaunchEnv {
  const built = buildChildEnv(env, { mode: 'subscription', key: null });
  const out = { ...built.env, ...(opts.extra ?? {}) };
  delete out.CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL; // Claude-specific
  delete out.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS; // Claude-specific
  if ((auth.mode === 'apiKey' || auth.mode === 'token') && auth.key && opts.keyVar) out[opts.keyVar] = auth.key;
  return { env: out, scrubbed: built.scrubbed };
}

export interface Spawned {
  child: ChildProcess;
  /** Last 4 KB of stderr (the caller redacts before showing it). */
  stderrTail: { text: string };
  /** Resolves with the exit code or signal when the process ends. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export function spawnAgent(command: string, args: string[], cwd: string, env: Record<string, string>, onPid: (pid: number) => void): Promise<Spawned> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const stderrTail = { text: '' };
    child.stderr?.on('data', (d: Buffer) => { stderrTail.text = (stderrTail.text + d.toString('utf8')).slice(-4000); });
    // a dead agent must not turn a broken pipe into an uncaught exception of the whole sidecar
    child.stdin?.on('error', () => undefined);
    child.stdout?.on('error', () => undefined);
    child.stderr?.on('error', () => undefined);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.once('exit', (code, signal) => r({ code, signal })));
    child.once('error', (e) => reject(new Error(`cannot start ${path.basename(command)}: ${e.message}`)));
    child.once('spawn', () => { if (child.pid !== undefined) onPid(child.pid); resolve({ child, stderrTail, exited }); });
  });
}

/** pid + every descendant, found through ps (a detached grandchild left the process group but is still a child of its parent). */
export async function processTree(root: number): Promise<number[]> {
  try {
    const { stdout } = await run('ps', ['-axo', 'pid=,ppid='], { timeout: 4000 });
    const kids = new Map<number, number[]>();
    for (const line of stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (m) kids.set(Number(m[2]), [...(kids.get(Number(m[2])) ?? []), Number(m[1])]);
    }
    const out: number[] = [];
    const todo = [root];
    while (todo.length) {
      const p = todo.pop()!;
      if (out.includes(p)) continue;
      out.push(p);
      todo.push(...(kids.get(p) ?? []));
    }
    return out;
  } catch {
    return [root];
  }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export function signalGroup(pid: number, sig: NodeJS.Signals): void {
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* gone */ } }
}

/**
 * Stops the agent and everything under it: SIGTERM to the process group (and to each descendant found before the kill, since
 * a detached grandchild is not in the group), SIGKILL after `termMs` for whatever is still alive.
 */
export async function killTree(pid: number, termMs: number, extraPids: number[] = []): Promise<void> {
  const tree = [...new Set([...(await processTree(pid)), ...extraPids])];
  signalGroup(pid, 'SIGTERM');
  for (const p of tree) { if (p !== pid) { try { process.kill(p, 'SIGTERM'); } catch { /* gone */ } } }
  const deadline = Date.now() + termMs;
  while (Date.now() < deadline && tree.some(alive)) await sleep(25);
  if (tree.some(alive)) {
    signalGroup(pid, 'SIGKILL');
    for (const p of tree) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    const end = Date.now() + 1000; // SIGKILL cannot be ignored; wait for the kernel (and our own reaping) to catch up
    while (Date.now() < end && tree.some(alive)) await sleep(20);
  }
}
