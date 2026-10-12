// Ends a process tree. Unix: the child leads a process group of its own (spawned detached), so a signal to the negative pid reaches
// everything it started. Windows has no process groups and `process.kill(-pid)` throws there: `taskkill /T` walks the tree instead
// (`/F` for SIGKILL; without it the tree is asked to close, which a window-less console child ignores, so callers still fall back to
// `child.kill`). Returns whether the signal was delivered.
import { spawnSync } from 'node:child_process';

export function killTree(pid: number, sig: NodeJS.Signals): boolean {
  if (process.platform === 'win32') {
    const args = ['/PID', String(pid), '/T'];
    if (sig === 'SIGKILL') args.push('/F');
    try { return spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true, timeout: 5000 }).status === 0; } catch { return false; }
  }
  try { process.kill(-pid, sig); return true; } catch { return false; }
}
