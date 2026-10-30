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

/** One file a run is told: the text as it goes into the prompt (before trimming), and whether a cap cut it. */
export type NoteFile = { scope: 'user' | 'project'; dirIndex: number | null; rel: string; path: string; text: string; shortened: boolean };

/** At most `room` UTF-16 units of `text`, never ending inside a surrogate pair (a lone half would be a broken character). */
export function cutUnits(text: string, room: number): string {
  if (text.length <= room) return text;
  const cut = text.slice(0, room);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** The user's own global CLAUDE.md as a file of the plan, or null (missing, empty, a symlink, unreadable). */
function userFile(env?: NotesOptions['env']): NoteFile | null {
  try {
    const dir = fs.realpathSync(claudeConfigDir(env));
    const got = readOne(dir, 'CLAUDE.md', USER_MEMORY_MAX_BYTES, true);
    if (!got || !got.text.trim()) return null;
    return { scope: 'user', dirIndex: null, rel: 'CLAUDE.md', path: path.join(dir, 'CLAUDE.md'), text: got.text, shortened: got.truncated };
  } catch {
    return null;
  }
}

/**
 * The files a run in `runDirs` is told, in order: the user's global CLAUDE.md first (unless switched off), then the files of
 * each directory, visited once, until [`PROJECT_TOTAL_MAX_BYTES`] (counted in UTF-16 units) is used up. The IDE's Project
 * notes panel mirrors this in `crates/files/src/claude_notes.rs`; `fixtures/claude-notes/cases.json` is checked by both.
 */
export function instructionFiles(runDirs: readonly string[], opts: NotesOptions = {}): NoteFile[] {
  const user = opts.includeUserMemory === false ? null : userFile(opts.env);
  const out: NoteFile[] = user ? [user] : [];
  const seen = new Set<string>();
  let total = user ? user.text.length : 0;
  runDirs.forEach((dir, dirIndex) => {
    let root: string;
    try { root = fs.realpathSync(dir); } catch { return; }
    if (seen.has(root)) return;
    seen.add(root);
    for (const rel of FILES) {
      if (total >= PROJECT_TOTAL_MAX_BYTES) break;
      const got = readOne(root, rel);
      if (!got) continue;
      const text = cutUnits(got.text, PROJECT_TOTAL_MAX_BYTES - total);
      total += text.length;
      out.push({ scope: 'project', dirIndex, rel, path: path.join(root, rel), text, shortened: got.truncated || text.length < got.text.length });
    }
  });
  return out;
}

/**
 * The user's own `CLAUDE.md` of the Claude config directory (what the Claude Code plugin always sees) as a prompt block, or ''. Read-only,
 * at most [`USER_MEMORY_MAX_BYTES`], a symlink is refused (also one that points out of the directory), `@imports` are not followed.
 */
export function userMemory(env?: NotesOptions['env']): { block: string; bytes: number } {
  return userBlock(userFile(env));
}

function userBlock(f: NoteFile | null): { block: string; bytes: number } {
  if (!f) return { block: '', bytes: 0 };
  const head = "User instructions. This is the user's own global CLAUDE.md (their personal preferences, valid in every project); follow it like the user's own instructions. A project instruction below wins where the two disagree.";
  return { block: `${head}\n\n--- ${f.path}${f.shortened ? ' (shortened)' : ''} ---\n${f.text.trim()}`, bytes: f.text.length };
}

/**
 * The CLAUDE.md files of the run directories as one prompt section, or '' when there are none. `@imports` inside the files are not
 * followed. Directories are visited once, in the order given (the working directory first); a file is read only when its real
 * path stays inside its directory.
 */
export function projectInstructions(runDirs: readonly string[], opts: NotesOptions = {}): string {
  const files = instructionFiles(runDirs, opts);
  const user = userBlock(files[0]?.scope === 'user' ? files[0] : null);
  const parts = files.filter((f) => f.scope === 'project').map((f) => `--- ${f.path}${f.shortened ? ' (shortened)' : ''} ---\n${f.text.trim()}`);
  const project = parts.length
    ? `Project instructions. These are the CLAUDE.md files of this run's directories; follow them like the user's own instructions.\n\n${parts.join('\n\n')}`
    : '';
  return [user.block, project].filter(Boolean).join('\n\n');
}
