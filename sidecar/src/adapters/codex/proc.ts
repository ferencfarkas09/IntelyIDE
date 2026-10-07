// The app-server child: spawned as its own process group leader (Rust kills the group if the sidecar dies, 5.6), stdout
// lines go to the RpcPeer, stderr is kept as a short redacted tail for error messages.
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { redact } from '../../redact.js';
import { RpcPeer, type RpcOptions } from './rpc.js';
import { parseVersion } from './wire.js';

const run = promisify(execFile);

export interface Server {
  child: ChildProcess;
  rpc: RpcPeer;
  stderr: { text: string };
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** SIGTERM the group, SIGKILL after the grace period. */
  stop(graceMs?: number): Promise<void>;
}

export function startServer(bin: string, args: string[], env: Record<string, string>, cwd: string, handlers: Pick<RpcOptions, 'onNotification' | 'onRequest'>, onSpawn?: (pid: number) => void): Server {
  const child = spawn(bin, args, { cwd, env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const stderr = { text: '' };
  child.stderr?.on('data', (d: Buffer) => { stderr.text = (stderr.text + d.toString('utf8')).slice(-4000); });
  child.stdin?.on('error', () => undefined); // EPIPE after the child died: the exit handler reports it
  const rpc = new RpcPeer({ ...handlers, write: (line) => { child.stdin?.write(`${line}\n`); } });
  if (child.stdout) readline.createInterface({ input: child.stdout }).on('line', (l) => rpc.feed(l));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('error', (e) => { stderr.text += `\n${e.message}`; resolve({ code: null, signal: null }); });
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  void exited.then(() => rpc.close(new Error('codex app-server exited')));
  if (child.pid !== undefined) onSpawn?.(child.pid);
  const alive = () => child.exitCode === null && child.signalCode === null;
  const kill = (sig: NodeJS.Signals) => { if (child.pid === undefined) return; try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
  return {
    child, rpc, stderr, exited,
    async stop(graceMs = 3000) {
      if (!alive()) return;
      kill('SIGTERM');
      await Promise.race([exited, new Promise<void>((r) => setTimeout(r, graceMs))]);
      if (alive()) { kill('SIGKILL'); await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 1000))]); }
    },
  };
}

export const stderrTail = (s: { text: string }, n = 400): string => redact(s.text.trim().slice(-n));

// ---------- one-shot CLI probes (no model call, no login flow) ----------
export async function cliVersion(bin: string, env: Record<string, string>): Promise<string | undefined> {
  try { return parseVersion((await run(bin, ['--version'], { timeout: 8000, env })).stdout); } catch { return undefined; }
}

/** `codex login status`: exit 0 = a login is stored. It does not prove the token still refreshes (spike finding). */
export async function loginStatus(bin: string, env: Record<string, string>): Promise<{ loggedIn: boolean; text: string }> {
  try {
    const { stdout, stderr } = await run(bin, ['login', 'status'], { timeout: 8000, env });
    return { loggedIn: true, text: `${stdout}${stderr}`.trim().slice(0, 200) };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string };
    return { loggedIn: false, text: `${x.stdout ?? ''}${x.stderr ?? ''}`.trim().slice(0, 200) };
  }
}

/** Feature names this CLI knows (`codex features list`), so `--disable` never names an unknown one. Not cached: the env (shim PATH) differs per session and the call is cheap. */
export function knownFeatures(bin: string, env: Record<string, string>): Promise<Set<string> | undefined> {
  return run(bin, ['features', 'list'], { timeout: 8000, env })
    .then(({ stdout }) => new Set(stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean)))
    .catch(() => undefined);
}
