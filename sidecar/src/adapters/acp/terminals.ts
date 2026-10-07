// terminal/* handlers we implement for ACP agents. The broker has already judged the command line before create() runs; this table
// only runs it: in its own process group, with our scrubbed environment (the git shim first in PATH, the agent cannot override PATH,
// GIT_* or credentials), output capped, and everything killed when the session ends.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Jail } from './jail.js';
import { killTree, signalGroup } from './launch.js';

export class TerminalError extends Error {
  constructor(message: string, readonly code: 'limit' | 'unknown' | 'cwd' | 'spawn') { super(message); }
}

/** Variables an agent may not set for its terminal: they would move the shim, the git dir, credentials or the loader. */
const BLOCKED = /^(PATH|HOME|SHELL|USER|LOGNAME|TMPDIR|BASH_ENV|ENV|IFS|PS4|PROMPT_COMMAND|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|XDG_[A-Z_]*|PAGER|EDITOR|VISUAL|RUBYOPT|PERL5OPT|LD_[A-Z_]*|DYLD_[A-Z_]*|GIT_[A-Z_]*|GH_[A-Z_]*|GITHUB_[A-Z_]*|SSH_[A-Z_]*|INTELY_[A-Z_]*|CLAUDE[A-Z_]*|ANTHROPIC[A-Z_]*|OPENAI[A-Z_]*|GEMINI[A-Z_]*|GOOGLE[A-Z_]*|npm_config_.*|NPM_CONFIG_.*)$/;
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_LIMIT = 1_000_000;
const MAX_TERMINALS = 8;

interface Term {
  child: ChildProcess;
  chunks: string[];
  bytes: number;
  limit: number;
  truncated: boolean;
  exit?: { exitCode: number | null; signal: string | null };
  done: Promise<void>;
}

export interface CreateParams { command: string; args?: string[] | null; env?: Array<{ name: string; value: string }> | null; cwd?: string | null; outputByteLimit?: number | null }

export class Terminals {
  private terms = new Map<string, Term>();
  /** Names of agent-supplied variables that were not applied (reported, never silently trusted). */
  ignoredEnv: string[] = [];

  constructor(private o: { jail: Jail; cwd: string; baseEnv: Record<string, string>; onPid: (pid: number) => void }) {}

  get running(): number { return [...this.terms.values()].filter((t) => !t.exit).length; }

  create(p: CreateParams): string {
    if (this.terms.size >= MAX_TERMINALS) throw new TerminalError(`at most ${MAX_TERMINALS} terminals per session`, 'limit');
    let cwd = this.o.cwd;
    if (p.cwd) {
      try { cwd = this.o.jail.resolve(p.cwd, 'read'); } catch (e) { throw new TerminalError((e as Error).message, 'cwd'); }
    }
    const env: Record<string, string> = { ...this.o.baseEnv };
    for (const v of p.env ?? []) {
      if (!v || !VALID_NAME.test(v.name) || BLOCKED.test(v.name)) { this.ignoredEnv.push(String(v?.name)); continue; }
      env[v.name] = String(v.value);
    }
    // The broker judged exactly this: a bare command line (no args, shell syntax) runs through sh -c, an argv runs as given.
    const shellLine = !p.args?.length && /[\s;&|<>()$`'"\\*?~#]/.test(p.command);
    const [cmd, argv] = shellLine ? ['/bin/sh', ['-c', p.command]] as const : [p.command, p.args ?? []] as const;
    const child = spawn(cmd, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const t: Term = { child, chunks: [], bytes: 0, limit: Math.max(1024, p.outputByteLimit ?? DEFAULT_LIMIT), truncated: false, done: undefined as never };
    const take = (d: Buffer) => {
      const s = d.toString('utf8');
      t.chunks.push(s);
      t.bytes += d.length;
      while (t.bytes > t.limit && t.chunks.length > 1) { t.bytes -= Buffer.byteLength(t.chunks.shift()!); t.truncated = true; }
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    t.done = new Promise<void>((resolve) => {
      child.once('exit', (exitCode, signal) => { t.exit = { exitCode, signal }; resolve(); });
      child.once('error', (e) => { take(Buffer.from(`${e.message}\n`)); t.exit = { exitCode: 127, signal: null }; resolve(); });
    });
    if (child.pid !== undefined) this.o.onPid(child.pid);
    const id = `term-${randomUUID().slice(0, 8)}`;
    this.terms.set(id, t);
    return id;
  }

  private get(id: string): Term {
    const t = this.terms.get(id);
    if (!t) throw new TerminalError(`unknown terminal ${id}`, 'unknown');
    return t;
  }

  output(id: string): { output: string; truncated: boolean; exitStatus: { exitCode: number | null; signal: string | null } | null } {
    const t = this.get(id);
    return { output: t.chunks.join(''), truncated: t.truncated, exitStatus: t.exit ?? null };
  }

  /** Output text without throwing, for tool cards. */
  peek(id: string): string | undefined {
    const t = this.terms.get(id);
    return t ? t.chunks.join('') : undefined;
  }

  async waitForExit(id: string): Promise<{ exitCode: number | null; signal: string | null }> {
    const t = this.get(id);
    await t.done;
    return t.exit!;
  }

  kill(id: string): void {
    const t = this.get(id);
    if (!t.exit && t.child.pid !== undefined) signalGroup(t.child.pid, 'SIGTERM');
  }

  release(id: string): void {
    const t = this.terms.get(id);
    if (!t) return;
    if (!t.exit && t.child.pid !== undefined) void killTree(t.child.pid, 1500);
    this.terms.delete(id);
  }

  /** Session end or forced kill: nothing an agent started may outlive it. */
  async killAll(termMs = 1500): Promise<void> {
    const live = [...this.terms.values()].filter((t) => !t.exit && t.child.pid !== undefined);
    await Promise.all(live.map((t) => killTree(t.child.pid!, termMs)));
    this.terms.clear();
  }
}
