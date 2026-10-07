// Path jail for the fs/* and terminal cwd handlers we offer to ACP agents (providers-plan 3.5): canonicalise, stay inside cwd or a
// granted add-dir, no symlink escape, never write into the git/hook/agent-config directories. The broker (policy/decide) decides on
// top; this layer is the structural part that does not depend on the policy channel.
import fs from 'node:fs';
import path from 'node:path';

export class JailError extends Error {
  constructor(message: string, readonly code: 'outside' | 'protected' | 'relative' | 'notFile' | 'tooLarge') { super(message); }
}

/** Directories an agent can never write into (hooks, repo config, agent config): policy hard-stops them too. */
const PROTECTED = new Set(['.git', '.husky', '.claude']);
export const MAX_READ_BYTES = 5 * 1024 * 1024;

export class Jail {
  private readonly roots: string[];

  constructor(cwd: string, addDirs: string[] = []) {
    this.roots = [cwd, ...addDirs].map((r) => realpathOrSelf(path.resolve(r)));
  }

  /** Real path of the nearest existing ancestor + the rest, so a symlinked parent cannot hide the true destination. */
  private canonical(abs: string): string {
    let head = abs;
    const tail: string[] = [];
    for (;;) {
      try { return path.join(fs.realpathSync(head), ...tail.reverse()); } catch {
        const parent = path.dirname(head);
        if (parent === head) return abs;
        tail.push(path.basename(head));
        head = parent;
      }
    }
  }

  private inside(p: string): boolean {
    return this.roots.some((r) => p === r || p.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
  }

  /** ACP paths are absolute; a relative one is refused instead of guessed. Returns the canonical path. */
  resolve(p: string, mode: 'read' | 'write'): string {
    if (!path.isAbsolute(p)) throw new JailError(`path must be absolute: ${p}`, 'relative');
    const real = this.canonical(path.resolve(p));
    if (!this.inside(real)) throw new JailError(`outside the workspace: ${p}`, 'outside');
    if (mode === 'write') {
      const rel = this.roots.map((r) => path.relative(r, real)).find((x) => !x.startsWith('..')) ?? '';
      // case-insensitive: .GIT / .Husky reach the real directories on APFS and NTFS
      if (rel.split(path.sep).some((c) => PROTECTED.has(c.toLowerCase()))) throw new JailError(`protected path: ${p}`, 'protected');
    }
    return real;
  }

  readText(p: string, line?: number | null, limit?: number | null): string {
    const real = this.resolve(p, 'read');
    const st = fs.statSync(real);
    if (!st.isFile()) throw new JailError(`not a file: ${p}`, 'notFile');
    if (st.size > MAX_READ_BYTES) throw new JailError(`file is larger than ${MAX_READ_BYTES} bytes: ${p}`, 'tooLarge');
    const text = fs.readFileSync(real, 'utf8');
    if (!line && !limit) return text;
    const lines = text.split('\n');
    const from = Math.max(0, (line ?? 1) - 1);
    return lines.slice(from, limit ? from + limit : undefined).join('\n');
  }

  writeText(p: string, content: string): string {
    const real = this.resolve(p, 'write');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    const target = this.resolve(p, 'write'); // re-check after mkdir: a symlink created in between must not redirect the write
    if (target !== real) throw new JailError(`path changed while writing: ${p}`, 'outside');
    try { if (fs.lstatSync(real).isSymbolicLink()) throw new JailError(`refusing to write through a symlink: ${p}`, 'outside'); } catch (e) { if (e instanceof JailError) throw e; }
    fs.writeFileSync(real, content, 'utf8');
    return real;
  }
}

function realpathOrSelf(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}
