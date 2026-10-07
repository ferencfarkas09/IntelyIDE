// CLI-originated permission prompts in an unattended run (permission-modes spec 6.3 item 9).
// `canUseTool` is also what the Claude CLI calls for ITS OWN prompts: the workspace boundary and, possibly, its dangerous-command
// prompts. In Ask and Edit a person answers them. In Automatic and Bypass nobody can say no, so answering every one of them from the
// cached Rust allow would remove the CLI's last-resort guard. The gate therefore answers such a prompt only for the reasons that a
// live probe MEASURED as benign (this list, pinned by a unit test) and denies every other one with a message that names the reason,
// so the list can be widened with evidence. Pure functions, no I/O beyond path canonicalisation.
import fs from 'node:fs';
import path from 'node:path';
import type { PermissionMode } from '../../types.js';

/**
 * What live probes L2, L5 and L10 measured on claude 2.1.284 under `acceptEdits`, the hook letting every call through (the CLI prompts for):
 *   `Path is outside allowed working directories`   Write/Edit outside the cwd (suggestion: addDirectories); BENIGN when Rust allowed it (Bypass)
 *   `This command requires approval`                every command without an allow rule: npm test, node -e, sh -c, python3 -c, curl, chmod, dd, ln; BENIGN
 *   (no reason, `blockedPath` set)                  a Bash command that names a path outside the cwd (rm, cat, ls, cd, touch, ls /etc); BENIGN when Rust allowed it
 *   (no reason, no path)                            `echo x | tee f`, `export FOO=1; ...`; BENIGN
 *   `Claude requested permissions to edit <p> which is a sensitive file.`   .bashrc, .zshrc, .npmrc, .mcp.json, .vscode/settings.json; NOT benign
 *   `Contains command_substitution`                 `$(...)` and backticks; NOT benign
 *   `find with '-delete' executes commands or modifies files ...`           NOT benign (a false denial for a harmless cleanup: widen with the owner's say-so)
 *   `Path contains '..' traversal after a directory segment, which may follow a symlink outside the working directory`   NOT benign
 * The CLI does NOT prompt for .gitignore, .env, .env.example, package.json, tsconfig.json, Makefile, .github/workflows/*.yml, scripts/*.sh, .eslintrc.js.
 */
export const BOUNDARY_REASON = 'Path is outside allowed working directories';

/**
 * The generic "no allow rule matched" prompt of a command the CLI does not auto-accept in `acceptEdits`. It carries no safety information
 * beyond "no rule": Rust has already judged the command (and its catastrophic forms are hard stops).
 */
export const NO_RULE_REASON = 'This command requires approval';

/** Reasons a CLI prompt may carry and still be answered from the cached Rust allow in Automatic and Bypass. Extend only with a measured reason. */
export const CLI_BENIGN_REASONS: readonly string[] = [BOUNDARY_REASON, NO_RULE_REASON];

/**
 * The CLI's guard for `cd <dir> && git ...` (live probe L9, claude 2.1.284: "This command changes directory before running a version-control
 * command, which can pick up untrusted hooks or repos"). The plugin-style flow of this IDE does it all the time (a task spans several
 * repositories). It is benign here because the directories are the user's own repositories and Rust has judged every path of the
 * command (a `cd` out of the run's folders is refused there), so the cached allow stands. Matched by prefix: the CLI appends text.
 */
export const CD_VCS_PREFIX = 'This command changes directory before running a version-control command';
export const CLI_BENIGN_PREFIXES: readonly string[] = [CD_VCS_PREFIX];
/** `Claude requested permissions to edit <path> which is a sensitive file.` (measured L2/L5). */
const SENSITIVE_FILE = /sensitive file/i;
const benign = (reason: string): boolean => CLI_BENIGN_REASONS.includes(reason) || CLI_BENIGN_PREFIXES.some((p) => reason.startsWith(p));

/**
 * The CLI's text heuristics ("Contains brace with quote character (expansion obfuscation)", "Contains zsh <N-M> numeric-range glob",
 * "Contains command_substitution") scan the RAW command string. A file written through a QUOTED heredoc (`cat > f <<'EOF' ... EOF`)
 * trips them on its content, which the shell never expands: in the owner's live Automatic run every such write of the developer role
 * was refused. Such a prompt is answered from the cached Rust allow when (a) every heredoc of the command is a pure file write
 * (`cat > file`, `tee file`, optionally after `mkdir -p`/`cd`), (b) its delimiter is quoted, and (c) the flagged feature is gone once the
 * bodies are removed. Anything else (an unquoted delimiter, a heredoc fed to bash/sh/python, a here-string, an unterminated body, a
 * feature that remains outside the bodies) keeps the refusal.
 */
const HEREDOC_REASONS: ReadonlyArray<{ reason: RegExp; feature: RegExp }> = [
  { reason: /^Contains brace with quote character/i, feature: /[{}]/ },
  { reason: /^Contains zsh <N-M> numeric-range glob/i, feature: /<\s*\d*\s*-\s*\d*\s*>/ },
  { reason: /^Contains command[ _]substitution/i, feature: /\$\(|\x60|<\(|>\(|\$\{/ },
];
const SINK_PATH = String.raw`[^\s;&|<>$\x60()\\'"{}]+`;
/** What is left of a heredoc line once the operator is cut out: only a plain write of the body into a file. */
const SINK = new RegExp(String.raw`^(?:(?:mkdir\s+-p|cd)\s+${SINK_PATH}\s*&&\s*)*(?:cat\s*>>?\s*${SINK_PATH}|tee\s+(?:-a\s+)?${SINK_PATH}(?:\s*>\s*/dev/null)?)$`);

type HeredocLine = { delim: string; dash: boolean; rest: string } | 'none' | 'unsafe';

/** The quoted-delimiter heredoc operator of one line (outside quotes), `'none'` when the line has none, `'unsafe'` when it cannot be judged. */
function heredocOnLine(line: string): HeredocLine {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (q === '"' && c === '\\') { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return 'none';
    if (c === '<' && line[i + 1] === '<') {
      if (line[i + 2] === '<') return 'unsafe';
      let j = i + 2;
      let dash = false;
      if (line[j] === '-') { dash = true; j++; }
      while (line[j] === ' ' || line[j] === '\t') j++;
      const m = /^(?:'([A-Za-z0-9_.-]+)'|"([A-Za-z0-9_.-]+)"|\\([A-Za-z0-9_.-]+))/.exec(line.slice(j));
      if (!m) return 'unsafe';
      return { delim: (m[1] ?? m[2] ?? m[3]) as string, dash, rest: `${line.slice(0, i)} ${line.slice(j + m[0].length)}`.replace(/\s+/g, ' ').trim() };
    }
  }
  return q ? 'unsafe' : 'none';
}

/** The command with the bodies of its quoted file-writing heredocs removed; `null` when there is none or any of them cannot be judged. */
export function stripQuotedHeredocBodies(command: string): string | null {
  const lines = command.split('\n');
  const out: string[] = [];
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const h = heredocOnLine(lines[i]);
    if (h === 'unsafe') return null;
    if (h === 'none') { out.push(lines[i]); continue; }
    if (!SINK.test(h.rest)) return null;
    let k = i + 1;
    while (k < lines.length && (h.dash ? lines[k].replace(/^\t+/, '') : lines[k]) !== h.delim) k++;
    if (k >= lines.length) return null;
    found = true;
    out.push(h.rest);
    i = k;
  }
  return found ? out.join('\n') : null;
}

/** True when the CLI flagged the CONTENT of a quoted file-writing heredoc, not the command itself. */
export function heredocFalsePositive(reason: string, command: string | undefined): boolean {
  if (!command) return false;
  const rule = HEREDOC_REASONS.find((r) => r.reason.test(reason));
  if (!rule) return false;
  const stripped = stripQuotedHeredocBodies(command);
  return stripped !== null && !rule.feature.test(stripped);
}

const MODE_NAME: Partial<Record<PermissionMode, string>> = { automatic: 'Automatic', bypass: 'Bypass' };

const TEXT_HEURISTIC = /brace with quote|numeric-range glob|command[ _]substitution/i;

export function cliPromptMessage(reason: string, mode: PermissionMode): string {
  const base = `The Claude CLI raised its own safety prompt (${reason}); the IDE does not answer those in ${MODE_NAME[mode] ?? mode} on its own.`;
  // The three text heuristics fire on shell syntax in the command string: the model can avoid them without a person.
  const hint = TEXT_HEURISTIC.test(reason) ? ' To create or change a file use the Write or Edit tool instead of a shell command; keep shell commands free of braces with quotes, <N-M> ranges and $(...).' : '';
  return mode === 'automatic' ? `${base}${hint} Automatic stays inside the run's folders: use Bypass for paths outside them, do it by hand, or switch to Ask to decide it yourself.` : `${base}${hint} Do it by hand, or switch to Ask to decide it yourself.`;
}

/** A path with symlinks in its existing part resolved (macOS /tmp and /var are links); a path that does not exist yet keeps its tail. */
function canon(p: string): string {
  let head = p;
  const tail: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync(head), ...tail); } catch {
      const up = path.dirname(head);
      if (up === head) return p;
      tail.unshift(path.basename(head));
      head = up;
    }
  }
}

const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/** Whether a path the CLI blocked is one that Rust judged: the intent's own paths (file tools) or, for a command, the verdict on the whole command. */
export function coveredByVerdict(blockedPath: string, intentPaths: readonly string[] | undefined, cwd: string | undefined): boolean {
  if (!intentPaths?.length) return true;
  const abs = (p: string) => path.resolve(cwd ?? '/', p.startsWith('~') ? p.replace(/^~/, process.env.HOME ?? '~') : p);
  const b = abs(blockedPath);
  const bc = canon(b);
  return intentPaths.some((raw) => {
    const p = abs(raw);
    return inside(b, p) || inside(bc, canon(p));
  });
}

const insideAny = (p: string, dirs: readonly string[], cwd: string | undefined): boolean => {
  const abs = (q: string) => path.resolve(cwd ?? '/', q);
  const a = abs(p);
  const ac = canon(a);
  return dirs.some((d) => { const r = abs(d); return inside(a, r) || inside(ac, canon(r)); });
};

export interface CliPromptInput {
  mode: PermissionMode;
  /** `options.decisionReason` of the canUseTool call (empty for a hook `ask` and for a plain "no rule matched" prompt). */
  reason?: string;
  blockedPath?: string;
  /** Paths of the intent Rust judged (file tools); empty for a command. */
  intentPaths?: readonly string[];
  cwd?: string;
  /** The run directories (cwd plus the added directories): what the CLI itself calls its allowed working directories. */
  runDirs?: readonly string[];
  /** The command string of a Bash call: lets the judge tell a heuristic that fired on a heredoc body from one that fired on the command. */
  command?: string;
}

/**
 * `null` = the prompt may be answered from the cached Rust allow; otherwise the reason it must be denied.
 * Automatic stays inside the run's folders (D5). Rust denies every out-of-jail path it can SEE, so a boundary prompt after a Rust allow means the
 * CLI saw a path Rust did not: Automatic answers it only when the path is in fact inside the run directories. Bypass has no boundary (D6): the cached
 * Rust allow stands.
 */
export function judgeCliPrompt(i: CliPromptInput): { reason: string } | null {
  const reason = (i.reason ?? '').trim();
  // Bypass (D6) has no prompts: the guards are Rust's hard stops (they speak first, in the hook) and the settings deny rules. Only the CLI's
  // sensitive-file prompt (.mcp.json, .vscode/settings.json: files that run code) stays a refusal; command substitution, find -delete and `..`
  // paths, which a person would just say yes to, are answered from the cached allow.
  if (i.mode === 'bypass' && !SENSITIVE_FILE.test(reason)) return null;
  if (reason && !benign(reason) && !heredocFalsePositive(reason, i.command)) return { reason };
  if (i.blockedPath && !coveredByVerdict(i.blockedPath, i.intentPaths, i.cwd)) return { reason: reason || `blocked path ${i.blockedPath}` };
  if (i.mode === 'automatic' && (reason === BOUNDARY_REASON || i.blockedPath)) {
    const paths = i.blockedPath ? [i.blockedPath] : [...(i.intentPaths ?? [])];
    const dirs = i.runDirs ?? (i.cwd ? [i.cwd] : []);
    if (!paths.length || !paths.every((p) => insideAny(p, dirs, i.cwd))) return { reason: reason || `path outside the run's folders: ${i.blockedPath}` };
  }
  return null;
}
