// The project instructions of a run: the CLAUDE.md files of its directories, put into the system prompt by the sidecar.
// Why not the CLI: a session runs with no setting sources (the user's plugins and hooks must not reach an IDE agent), and the CLI
// loads the CLAUDE.md of an added directory only through the `--add-dir` flag, which also loads that directory's plugins and hooks
// (measured, claude 2.1.284: see settings.ts). So the IDE reads the files itself and the isolation stays whole.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Per file and in total: a runaway CLAUDE.md must not eat the context. */
export const PROJECT_FILE_MAX_BYTES = 32 * 1024;
export const PROJECT_TOTAL_MAX_BYTES = 96 * 1024;
/** The user's own global CLAUDE.md: at most this much of it, counted against the same total (the project notes get the rest). */
export const USER_MEMORY_MAX_BYTES = 32 * 1024;

/** In the order the CLI reads them for one directory (project, project in .claude, project-local). */
const FILES = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];

const inside = (root: string, p: string): boolean => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

function readOne(root: string, rel: string, maxBytes = PROJECT_FILE_MAX_BYTES, noLink = false): { text: string; truncated: boolean } | null {
  const file = path.join(root, rel);
  let real: string;
  try {
    if (noLink && fs.lstatSync(file).isSymbolicLink()) return null;
    real = fs.realpathSync(file);
    // a symlink out of the run directory (typically to ~/.claude/CLAUDE.md, the user's global instructions) is not project content
    if (!inside(root, real)) return null;
    const st = fs.statSync(real);
    if (!st.isFile() || st.size === 0) return null;
    const fd = fs.openSync(real, 'r');
    try {
      const buf = Buffer.alloc(Math.min(st.size, maxBytes));
      fs.readSync(fd, buf, 0, buf.length, 0);
      return { text: buf.toString('utf8'), truncated: st.size > maxBytes };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export type NotesOptions = {
  /** The user's global memory file goes first (default true); `false` = the `agents.includeUserMemory` switch is off. */
  includeUserMemory?: boolean;
  /** Where the Claude config directory comes from (CLAUDE_CONFIG_DIR, else HOME/.claude); default: the sidecar's own environment. */
  env?: Readonly<Record<string, string | undefined>> | null;
};

/** The Claude config directory the way the CLI finds it: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(env: NotesOptions['env'] = process.env): string {
  const e = env ?? process.env;
  return e.CLAUDE_CONFIG_DIR?.trim() || path.join(e.HOME?.trim() || os.homedir(), '.claude');
}

/**
 * The user's own `CLAUDE.md` of the Claude config directory (what the Claude Code plugin always sees) as a prompt block, or ''. Read-only,
 * at most [`USER_MEMORY_MAX_BYTES`], a symlink is refused (also one that points out of the directory), `@imports` are not followed.
 */
export function userMemory(env?: NotesOptions['env']): { block: string; bytes: number } {
  try {
    const dir = fs.realpathSync(claudeConfigDir(env));
    const got = readOne(dir, 'CLAUDE.md', USER_MEMORY_MAX_BYTES, true);
    if (!got || !got.text.trim()) return { block: '', bytes: 0 };
    const head = "User instructions. This is the user's own global CLAUDE.md (their personal preferences, valid in every project); follow it like the user's own instructions. A project instruction below wins where the two disagree.";
    return { block: `${head}\n\n--- ${path.join(dir, 'CLAUDE.md')}${got.truncated ? ' (shortened)' : ''} ---\n${got.text.trim()}`, bytes: got.text.length };
  } catch {
    return { block: '', bytes: 0 };
  }
}

/**
 * The CLAUDE.md files of the run directories as one prompt section, or '' when there are none. `@imports` inside the files are not
 * followed. Directories are visited once, in the order given (the working directory first); a file is read only when its real
 * path stays inside its directory.
 */
export function projectInstructions(runDirs: readonly string[], opts: NotesOptions = {}): string {
  const user = opts.includeUserMemory === false ? { block: '', bytes: 0 } : userMemory(opts.env);
  const seen = new Set<string>();
  const parts: string[] = [];
  let total = user.bytes;
  for (const dir of runDirs) {
    let root: string;
    try { root = fs.realpathSync(dir); } catch { continue; }
    if (seen.has(root)) continue;
    seen.add(root);
    for (const rel of FILES) {
      if (total >= PROJECT_TOTAL_MAX_BYTES) break;
      const got = readOne(root, rel);
      if (!got) continue;
      const room = PROJECT_TOTAL_MAX_BYTES - total;
      const text = got.text.length > room ? got.text.slice(0, room) : got.text;
      const cut = got.truncated || text.length < got.text.length;
      total += text.length;
      parts.push(`--- ${path.join(root, rel)}${cut ? ' (shortened)' : ''} ---\n${text.trim()}`);
    }
  }
  const project = parts.length
    ? `Project instructions. These are the CLAUDE.md files of this run's directories; follow them like the user's own instructions.\n\n${parts.join('\n\n')}`
    : '';
  return [user.block, project].filter(Boolean).join('\n\n');
}
