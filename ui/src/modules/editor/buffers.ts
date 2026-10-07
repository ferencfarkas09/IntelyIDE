import { Text, Transaction, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { createStore, produce } from "solid-js/store";
import { ipc } from "../../ipc";
import type { Encoding, Eol, FileChanged, FileRead } from "../../ipc/files";
import { t } from "../../i18n";
import { activateTab, closeTab, openTab, tabs, updateTab } from "../../platform/tabs";
import { readScoped, writeScoped } from "../../store/scopedStorage";
import { toast } from "../../ui-kit";
import { confirmDialog } from "./dialogs";
import { baseName, classifyRead, detectIndent, ENCODING_LABEL, fileTabId, toDisk, toDoc, type Indent, type ReadState } from "./logic";

export interface Disk {
  /** Normalised to "\n". */
  text: string;
  mtimeMs: number;
  eol: Eol;
}

export interface Conflict {
  /** `external`: changed on disk while the buffer has edits. `stale`: a save was refused because of that. `deleted`: gone from disk. */
  kind: "external" | "stale" | "deleted";
  disk?: Disk;
}

export interface Buffer {
  tabId: string;
  repoId: string;
  path: string;
  status: "loading" | ReadState | "error";
  error?: string;
  size: number;
  mtimeMs: number;
  eol: Eol;
  /** How the bytes on disk map to text; a save writes the file back in it. */
  encoding: Encoding;
  /** The file is over 5 MiB: only a prefix was read, so the buffer is read-only and never saved. */
  partial: boolean;
  indent: Indent;
  dirty: boolean;
  saving: boolean;
  conflict?: Conflict;
}

const [buffers, setBuffers] = createStore<Record<string, Buffer>>({});
export { buffers };

// Not reactive and not proxied: CodeMirror objects stay out of the store.
const states = new Map<string, EditorState>();
const views = new Map<string, EditorView>();
const savedDocs = new Map<string, Text>();
const revealed = new Set<string>();
/** "Reopen with encoding" choices; later reads of the same tab (reload, external change) decode the same way. */
const forcedEncoding = new Map<string, Encoding>();
const disk = (text: string) => Text.of(text.split("\n"));

const errorText = (e: unknown): string => (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e));
const errorCode = (e: unknown): string | undefined => (e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined);

/** The edit state that survives a tab remount (undo history, selection). */
export const stashedState = (tabId: string): EditorState | undefined => states.get(tabId);
export const savedDoc = (tabId: string): Text | undefined => savedDocs.get(tabId);

export function attachView(tabId: string, view: EditorView): void {
  views.set(tabId, view);
}

export function detachView(tabId: string, view: EditorView): void {
  if (views.get(tabId) === view) {
    views.delete(tabId);
    states.set(tabId, view.state);
  }
  view.destroy();
}

export const viewOf = (tabId: string): EditorView | undefined => views.get(tabId);

/** The document as the editor holds it ("\n" line breaks). */
export function currentDoc(tabId: string): string | undefined {
  const state = views.get(tabId)?.state ?? states.get(tabId);
  return state ? state.sliceDoc() : savedDocs.get(tabId)?.toString();
}

/** The text as it would be written (CRLF files get their line breaks back). */
export function currentText(tabId: string): string | undefined {
  const doc = currentDoc(tabId);
  return doc === undefined || !buffers[tabId] ? undefined : toDisk(doc, buffers[tabId].eol);
}

function applyRead(tabId: string, r: FileRead): void {
  const status = classifyRead(r, revealed.has(tabId));
  setBuffers(tabId, { status, size: r.size, mtimeMs: r.mtimeMs, eol: r.eol, encoding: r.encoding ?? "utf8", partial: r.tooLarge && r.text !== undefined, dirty: false, conflict: undefined, error: undefined });
  if (status !== "ready") return;
  const text = toDoc(r.text ?? "", r.eol);
  savedDocs.set(tabId, disk(text));
  setBuffers(tabId, "indent", detectIndent(text));
}

const readOpts = (tabId: string) => ({ reveal: revealed.has(tabId), encoding: forcedEncoding.get(tabId) });

async function load(tabId: string): Promise<void> {
  const b = buffers[tabId];
  try {
    applyRead(tabId, await ipc.files.readFile(b.repoId, b.path, readOpts(tabId)));
  } catch (e) {
    setBuffers(tabId, { status: "error", error: errorText(e) });
  }
}

/** Makes sure the buffer of an open file tab exists; loads it on first use. */
export function ensureBuffer(tabId: string, repoId: string, path: string): void {
  if (buffers[tabId]) return;
  setBuffers(tabId, { tabId, repoId, path, status: "loading", size: 0, mtimeMs: 0, eol: "lf", encoding: "utf8", partial: false, indent: detectIndent(""), dirty: false, saving: false });
  watch();
  void load(tabId);
}

function discardBuffer(tabId: string): void {
  states.delete(tabId);
  views.delete(tabId);
  savedDocs.delete(tabId);
  revealed.delete(tabId);
  forcedEncoding.delete(tabId);
  setBuffers(produce((all) => void delete all[tabId]));
}

export async function revealSecret(tabId: string): Promise<void> {
  revealed.add(tabId);
  await load(tabId);
}

export async function reloadFromDisk(tabId: string): Promise<void> {
  states.delete(tabId);
  const view = views.get(tabId);
  await load(tabId);
  const saved = savedDocs.get(tabId);
  if (view && saved) replaceDoc(view, saved);
  updateTab(tabId, { dirty: false });
}

/** Status-bar picker: decodes the file again with `encoding`. Unsaved edits are dropped, so a dirty buffer asks first. */
export async function reopenWithEncoding(tabId: string, encoding: Encoding): Promise<void> {
  const b = buffers[tabId];
  if (!b || b.status !== "ready" || b.encoding === encoding) return;
  if (b.dirty) {
    const answer = await confirmDialog({ title: t("editor.buf.reopenTitle", { name: baseName(b.path), encoding: ENCODING_LABEL[encoding] }), description: t("editor.buf.reopenDesc"), confirmLabel: t("editor.buf.reopen"), danger: true });
    if (answer !== "confirm") return;
  }
  try {
    const r = await ipc.files.readFile(b.repoId, b.path, { reveal: revealed.has(tabId), encoding });
    if (r.text === undefined) throw new Error(t("editor.buf.notText"));
    forcedEncoding.set(tabId, encoding);
    states.delete(tabId);
    const view = views.get(tabId);
    applyRead(tabId, r);
    const saved = savedDocs.get(tabId);
    if (view && saved) replaceDoc(view, saved);
    updateTab(tabId, { dirty: false });
  } catch (e) {
    toast.show({ tone: "danger", title: t("editor.buf.reopenFail", { encoding: ENCODING_LABEL[encoding] }), description: errorText(e) });
  }
}

function replaceDoc(view: EditorView, doc: Text): void {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc }, annotations: Transaction.addToHistory.of(false) });
}

export function setIndent(tabId: string, indent: Indent): void {
  setBuffers(tabId, "indent", indent);
}

/** Called by the editor on every transaction that changed the document. */
export function noteEdited(tabId: string, state: EditorState): void {
  const saved = savedDocs.get(tabId);
  const dirty = !!saved && !state.doc.eq(saved);
  if (buffers[tabId]?.dirty === dirty) return;
  setBuffers(tabId, "dirty", dirty);
  updateTab(tabId, { dirty });
}

export const isDirty = (tabId: string): boolean => !!buffers[tabId]?.dirty;
export const dirtyTabIds = (): string[] => tabs().filter((t) => t.type === "file" && buffers[t.id]?.dirty).map((t) => t.id);

/** Writes the buffer. Returns false when nothing was saved (clean, conflict, error). */
export async function saveBuffer(tabId: string): Promise<boolean> {
  const b = buffers[tabId];
  const text = currentText(tabId);
  if (!b || b.status !== "ready" || b.saving || b.partial || text === undefined) return false;
  const written = views.get(tabId)?.state.doc ?? states.get(tabId)?.doc ?? savedDocs.get(tabId)!;
  setBuffers(tabId, "saving", true);
  try {
    const { mtimeMs } = await ipc.files.writeFile(b.repoId, b.path, text, b.mtimeMs, { encoding: b.encoding });
    savedDocs.set(tabId, written);
    setBuffers(tabId, { mtimeMs, conflict: undefined });
    const now = views.get(tabId)?.state ?? states.get(tabId);
    if (now) noteEdited(tabId, now);
    else setBuffers(tabId, "dirty", false);
    updateTab(tabId, { dirty: buffers[tabId].dirty });
    return true;
  } catch (e) {
    if (errorCode(e) === "staleFile") await markStale(tabId);
    else toast.show({ tone: "danger", title: t("editor.buf.saveFail", { name: baseName(b.path) }), description: errorText(e) });
    return false;
  } finally {
    setBuffers(tabId, "saving", false);
  }
}

async function markStale(tabId: string): Promise<void> {
  const b = buffers[tabId];
  try {
    const r = await ipc.files.readFile(b.repoId, b.path, readOpts(tabId));
    if (r.text === undefined) throw new Error("unreadable");
    setBuffers(tabId, "conflict", { kind: "stale", disk: { text: toDoc(r.text, r.eol), mtimeMs: r.mtimeMs, eol: r.eol } });
  } catch {
    setBuffers(tabId, "conflict", { kind: "deleted" });
  }
}

export async function saveAll(): Promise<void> {
  await Promise.all(dirtyTabIds().map(saveBuffer));
}

/** Conflict choice: take the version on disk and drop the edits. */
export function useDiskVersion(tabId: string): void {
  const c = buffers[tabId]?.conflict;
  if (!c?.disk) return void reloadFromDisk(tabId);
  adoptDisk(tabId, c.disk);
}

/** Conflict choice: keep the edits; the next save overwrites what is on disk (or recreates the file). */
export function keepMine(tabId: string): void {
  const c = buffers[tabId]?.conflict;
  if (!c) return;
  if (c.disk) setBuffers(tabId, { mtimeMs: c.disk.mtimeMs, eol: c.disk.eol });
  else setBuffers(tabId, { mtimeMs: 0, dirty: true });
  setBuffers(tabId, "conflict", undefined);
  if (!c.disk) updateTab(tabId, { dirty: true });
}

export async function overwrite(tabId: string): Promise<void> {
  keepMine(tabId);
  await saveBuffer(tabId);
}

function adoptDisk(tabId: string, d: Disk): void {
  const doc = disk(d.text);
  savedDocs.set(tabId, doc);
  setBuffers(tabId, { mtimeMs: d.mtimeMs, eol: d.eol, dirty: false, conflict: undefined, size: d.text.length });
  const view = views.get(tabId);
  if (view) replaceDoc(view, doc);
  else states.delete(tabId);
  updateTab(tabId, { dirty: false });
}

let watching = false;
function watch(): void {
  if (watching) return;
  watching = true;
  ipc.files.onFileChanged((e) => void onFileChanged(e));
}

async function onFileChanged(e: FileChanged): Promise<void> {
  const tabId = fileTabId(e.repoId, e.path);
  const b = buffers[tabId];
  if (!b || b.status !== "ready" || !tabs().some((t) => t.id === tabId)) return;
  if (e.kind === "deleted") return setBuffers(tabId, "conflict", { kind: "deleted" });
  let r: FileRead;
  try {
    r = await ipc.files.readFile(b.repoId, b.path, readOpts(tabId));
  } catch {
    return;
  }
  if (r.text === undefined || r.mtimeMs === buffers[tabId]?.mtimeMs) return;
  const d: Disk = { text: toDoc(r.text, r.eol), mtimeMs: r.mtimeMs, eol: r.eol };
  if (savedDocs.get(tabId)?.toString() === d.text) return void setBuffers(tabId, { mtimeMs: d.mtimeMs, eol: d.eol });
  if (buffers[tabId]?.dirty) setBuffers(tabId, "conflict", { kind: "external", disk: d });
  else adoptDisk(tabId, d);
}

const RECENT_KEY = "intely.editor.recent";
const RECENT_MAX = 20;
export interface RecentFile {
  repoId: string;
  path: string;
}
export function recentFiles(): RecentFile[] {
  try {
    const value: unknown = JSON.parse(readScoped(RECENT_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is RecentFile => !!v && typeof v.repoId === "string" && typeof v.path === "string") : [];
  } catch {
    return [];
  }
}
function noteRecent(repoId: string, path: string): void {
  const next = [{ repoId, path }, ...recentFiles().filter((r) => !(r.repoId === repoId && r.path === path))].slice(0, RECENT_MAX);
  writeScoped(RECENT_KEY, JSON.stringify(next));
}

export interface OpenFileOptions {
  /** 1-based; the editor moves the cursor there. */
  line?: number;
  column?: number;
}

/** Opens (or focuses) the file tab of a repo-relative path. Also reachable as the command `editor.openFile`. */
export function openFile(repoId: string, path: string, opts: OpenFileOptions = {}): string {
  const id = fileTabId(repoId, path);
  if (!tabs().some((t) => t.id === id)) discardBuffer(id);
  ensureBuffer(id, repoId, path);
  noteRecent(repoId, path);
  return openTab({ type: "file", id, title: baseName(path), params: { repoId, path, ...opts, jump: opts.line ? Date.now() : undefined } });
}

/** A dirty tab asks before it closes. */
export function beforeCloseFile(tab: { id: string; title: string }): boolean {
  if (!isDirty(tab.id)) return true;
  void closeWithPrompt(tab.id, tab.title);
  return false;
}

async function closeWithPrompt(tabId: string, title: string): Promise<void> {
  activateTab(tabId);
  const answer = await confirmDialog({
    title: t("editor.buf.saveTitle", { title }),
    description: t("editor.buf.saveDesc"),
    confirmLabel: t("editor.buf.save"),
    extra: { id: "discard", label: t("editor.buf.dontSave"), danger: true },
  });
  if (answer === "cancel") return;
  if (answer === "confirm" && !(await saveBuffer(tabId))) return;
  closeTab(tabId, { force: true });
}

export function resetBuffers(): void {
  for (const id of Object.keys(buffers)) discardBuffer(id);
}
