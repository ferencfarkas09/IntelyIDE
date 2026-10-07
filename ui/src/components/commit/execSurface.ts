import { createSignal } from "solid-js";
import { ipc } from "../../ipc";

/** A changed file that runs code when the human commits, pushes, installs, lints, tests or builds. */
export interface ExecFile {
  repoId: string;
  path: string;
}

export interface RepoPaths {
  repoId: string;
  paths: readonly string[];
}

const keyOf = (f: ExecFile): string => `${f.repoId}\0${f.path}`;

/**
 * The files among `repos` that run code. The list lives in Rust (`exec_surface_check`); a failing check shows no warning
 * rather than blocking a commit, because the warning never decides anything.
 */
export async function findExecSurface(repos: readonly RepoPaths[]): Promise<ExecFile[]> {
  const all = repos.flatMap((r) => r.paths.map((path) => ({ repoId: r.repoId, path })));
  if (!all.length) return [];
  try {
    const flags = await ipc.execSurfaceCheck(all.map((f) => f.path));
    return all.filter((_, i) => flags[i] === true);
  } catch (e) {
    console.error("exec surface check failed", e);
    return [];
  }
}

// ---- dismissal: per commit attempt, a new file brings the banner back -------------------------------------------------

const [dismissed, setDismissed] = createSignal<ReadonlySet<string>>(new Set<string>());

export function dismissExecWarning(files: readonly ExecFile[]): void {
  setDismissed((s) => new Set<string>([...s, ...files.map(keyOf)]));
}

export const resetExecDismissal = (): void => void setDismissed(new Set<string>());

/** True while some file has not been dismissed yet (a file that appears later makes this true again). Reactive. */
export const hasUndismissed = (files: readonly ExecFile[]): boolean => files.some((f) => !dismissed().has(keyOf(f)));

// ---- confirmation of Commit and Push ----------------------------------------------------------------------------------

const [execAsk, setExecAsk] = createSignal<{ files: ExecFile[]; resolve: (ok: boolean) => void } | null>(null);
export const execSurfaceConfirmRequest = execAsk;

/** Commit and Push shows the files once more; the human can always say yes. */
export function confirmExecSurface(files: ExecFile[]): Promise<boolean> {
  return new Promise<boolean>((resolve) => setExecAsk({ files, resolve }));
}

export function answerExecSurfaceConfirm(ok: boolean): void {
  const ask = execAsk();
  setExecAsk(null);
  ask?.resolve(ok);
}
