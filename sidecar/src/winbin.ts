// Windows launch of the claude CLI. npm installs it as `claude.cmd`, a batch file Node cannot spawn without a shell (and the
// IDE never asks for one): the batch file names the real program next to it, `%dp0%\node_modules\...\cli.js` or a `.exe`.
// That program is what the SDK and the version probe start. Everywhere else the path is returned unchanged.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export interface WinBinIo { platform?: NodeJS.Platform; read?: (p: string) => string; isFile?: (p: string) => boolean }

const isFileDefault = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };

/** The program an npm `.cmd` shim runs, resolved below the shim's own folder; the input when it is not such a shim or the
 * target is missing or outside that folder (a crafted `.cmd` cannot point the IDE elsewhere). */
export function claudeExecutable(bin: string, io: WinBinIo = {}): string {
  const platform = io.platform ?? process.platform;
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(bin)) return bin;
  const p = path.win32;
  let text: string;
  try { text = (io.read ?? ((f) => readFileSync(f, 'utf8')))(bin); } catch { return bin; }
  // the quoted program right before `%*` (the arguments); `"%dp0%\node.exe"` earlier in npm's shim is the interpreter
  const m = /"%~?dp0%?\\?([^"%\r\n]+\.(?:js|cjs|mjs|exe))"\s*%\*/i.exec(text);
  if (!m) return bin;
  const base = p.dirname(bin);
  const target = p.resolve(base, m[1]!);
  if (!target.toLowerCase().startsWith(`${base.toLowerCase()}\\`)) return bin;
  return (io.isFile ?? isFileDefault)(target) ? target : bin;
}

/** Command and leading arguments that run `bin` without a shell. Windows: a `.js` CLI (what an npm `claude.cmd` resolves to) runs
 * on this Node, since Windows does not read a shebang. Elsewhere `bin` runs as it is, through its shebang, as before. */
export function commandOf(bin: string, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } {
  return platform === 'win32' && /\.(c|m)?js$/i.test(bin) ? { cmd: process.execPath, args: [bin] } : { cmd: bin, args: [] };
}
