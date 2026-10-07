import { t } from "../../i18n";
import { createEffect, createRoot, createSignal, on } from "solid-js";
import { ipc } from "../../ipc";
import { execute } from "../../platform/commands";
import { setToolWindow } from "../../platform/rail";
import { errorText } from "../../store/snapshots";
import { workspace } from "../../store/workspace";
import { resolvedTheme, toast } from "../../ui-kit";
import { resolveInRepo, type FileRef } from "./links";
import type { TermView } from "./view";

export const TERMINAL_ID = "terminal";

export interface TerminalInfo {
  id: string;
  repoId?: string;
  title: string;
  /** Where the shell is, as far as it tells us (OSC 7); starts as the directory it was opened in. */
  cwd: string;
  /** Set once the shell is gone: its exit code, or null when a signal ended it. */
  exit?: { code: number | null };
}

const [terminals, setTerminals] = createSignal<readonly TerminalInfo[]>([]);
const [activeId, setActiveId] = createSignal<string | null>(null);
const [lastRepoId, setLastRepoId] = createSignal<string | undefined>(undefined);
const views = new Map<string, TermView>();
// Output and exit events can beat the registration of a terminal that is still opening.
const earlyData = new Map<string, string[]>();
const earlyExit = new Map<string, number | null>();
let wired = false;

export { terminals };
export const activeTerminalId = activeId;
export const viewOf = (id: string): TermView | undefined => views.get(id);

const patch = (id: string, change: Partial<TerminalInfo>) => setTerminals((all) => all.map((t) => (t.id === id ? { ...t, ...change } : t)));
const repos = () => workspace()?.repos ?? [];

/** The repo a new terminal opens in when none is asked for: the active terminal's, the last used, else the first. */
export function defaultRepoId(): string | undefined {
  const current = terminals().find((t) => t.id === activeId())?.repoId;
  const known = (id: string | undefined) => (id && repos().some((r) => r.id === id) ? id : undefined);
  return known(current) ?? known(lastRepoId()) ?? [...repos()].sort((a, b) => a.order - b.order)[0]?.id;
}

function markExited(id: string, code: number | null): void {
  patch(id, { exit: { code } });
  views.get(id)?.write(`\r\n\x1b[90m[process exited${code === null ? "" : ` with code ${code}`}]\x1b[0m\r\n`);
}

function wire(): void {
  if (wired) return;
  wired = true;
  ipc.term.onData(({ termId, data }) => {
    const view = views.get(termId);
    if (view) view.write(data);
    else earlyData.set(termId, [...(earlyData.get(termId) ?? []), data]);
  });
  ipc.term.onExit(({ termId, code }) => {
    if (views.has(termId)) markExited(termId, code);
    else earlyExit.set(termId, code);
  });
}

function titleFor(repoId: string | undefined, cwd: string): string {
  const base = repos().find((r) => r.id === repoId)?.name ?? (cwd.split("/").filter(Boolean).pop() || "Terminal");
  const taken = new Set(terminals().map((t) => t.title));
  for (let n = 1; ; n++) {
    const title = n === 1 ? base : `${base} ${n}`;
    if (!taken.has(title)) return title;
  }
}

/** Opens a terminal (in a repo root, or `cwd`), makes it the active one and shows the bottom panel. Resolves to its id, or undefined when it could not start. */
export async function openTerminal(opts: { repoId?: string; cwd?: string } = {}): Promise<string | undefined> {
  wire();
  const { createView } = await import("./view");
  let id = "";
  const sessionRoot = () => repos().find((r) => r.id === opts.repoId)?.path;
  const view = await createView({
    onInput: (data) => id && !terminals().find((t) => t.id === id)?.exit && void ipc.term.write(id, data).catch(() => {}),
    onResize: (cols, rows) => id && void ipc.term.resize(id, cols, rows).catch(() => {}),
    onCwd: (path) => id && patch(id, { cwd: path }),
    isLink: (ref) => !!id && !!resolveInRepo(ref.path, terminals().find((t) => t.id === id)?.cwd ?? "/", repos()),
    openLink: (ref) => openFileLink(id, ref),
  });
  let opened;
  try {
    opened = await ipc.term.open({ repoId: opts.repoId, cwd: opts.cwd, cols: view.term.cols, rows: view.term.rows });
  } catch (e) {
    view.dispose();
    toast.error(t("term.openFailed"), errorText(e));
    return undefined;
  }
  // Everything from here to the end of the function runs without yielding, so no event slips between.
  id = opened.termId;
  const cwd = opts.cwd ?? sessionRoot() ?? opened.cwd ?? "/";
  views.set(id, view);
  setTerminals((all) => [...all, { id, repoId: opts.repoId, title: titleFor(opts.repoId, cwd), cwd }]);
  if (opts.repoId) setLastRepoId(opts.repoId);
  for (const chunk of earlyData.get(id) ?? []) view.write(chunk);
  earlyData.delete(id);
  const exited = earlyExit.get(id);
  if (exited !== undefined) (earlyExit.delete(id), markExited(id, exited));
  setActiveId(id);
  setToolWindow("bottom", TERMINAL_ID);
  return id;
}

function openFileLink(id: string, ref: FileRef): void {
  const cwd = terminals().find((t) => t.id === id)?.cwd;
  const target = cwd ? resolveInRepo(ref.path, cwd, repos()) : undefined;
  if (target) void execute("editor.openFile", { repoId: target.repoId, path: target.path, line: ref.line, column: ref.column });
}

export function closeTerminal(id: string): void {
  const all = terminals();
  const at = all.findIndex((t) => t.id === id);
  if (at < 0) return;
  void ipc.term.close(id).catch(() => {});
  views.get(id)?.dispose();
  views.delete(id);
  const rest = all.filter((t) => t.id !== id);
  setTerminals(rest);
  if (activeId() === id) setActiveId((rest[at] ?? rest[at - 1])?.id ?? null);
  if (!rest.length) setToolWindow("bottom", null);
}

export const closeActive = (): void => void (activeId() && closeTerminal(activeId()!));

export function activateTerminal(id: string): void {
  if (terminals().some((t) => t.id === id)) setActiveId(id);
}

/** Ctrl+Tab style cycling over the terminal tabs. */
export function cycleTerminal(step: 1 | -1): void {
  const all = terminals();
  const at = all.findIndex((t) => t.id === activeId());
  if (all.length > 1 && at >= 0) setActiveId(all[(at + step + all.length) % all.length].id);
}

createRoot(() => {
  // The theme attribute changes before this effect, but the stylesheet needs a frame to settle.
  createEffect(on(resolvedTheme, () => requestAnimationFrame(() => views.forEach((v) => v.setTheme())), { defer: true }));
});

/** Test hook: forget every terminal without closing anything. */
export function resetTerminals(): void {
  views.forEach((v) => v.dispose());
  views.clear();
  earlyData.clear();
  earlyExit.clear();
  setTerminals([]);
  setActiveId(null);
  setLastRepoId(undefined);
}
