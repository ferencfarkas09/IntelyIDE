import { createEffect, createRoot, createSignal, on } from "solid-js";
import type { MessageMode } from "../../ipc";
import { messageMode as workspaceMessageMode, saveWorkspace, workspace } from "../../store/workspace";
import { activeId } from "../../store/workspaces";
import { readStored, writeStored } from "../../ui-kit";
import { HISTORY_LIMIT, pushHistory } from "./logic";

const KEY_HISTORY = "intely.commit.history";
const KEY_DRAFT = "intely.commit.draft";

function readJson<T>(key: string, fallback: T, valid: (v: unknown) => v is T): T {
  const raw = readStored(key);
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return valid(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

interface Draft {
  shared: string;
  repos: Record<string, string>;
}
const isDraft = (v: unknown): v is Draft =>
  !!v && typeof v === "object" && typeof (v as { shared?: unknown }).shared === "string" && !!(v as { repos?: unknown }).repos && typeof (v as { repos?: unknown }).repos === "object";

/** Drafts are per workspace ((design notes: workspaces-spec) 4.13): `{ [workspaceId]: { shared, repos } }`. */
const MAX_DRAFT_WORKSPACES = 50;
/** The flat draft of before the registry belongs to the migrated workspace. */
const LEGACY_WORKSPACE = "w-migrated";

function readDrafts(): Record<string, Draft> {
  const raw = readStored(KEY_DRAFT);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isDraft(parsed)) {
      // One-time migration of the old flat value.
      const migrated = { [LEGACY_WORKSPACE]: parsed };
      writeStored(KEY_DRAFT, JSON.stringify(migrated));
      return migrated;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => isDraft(v))) as Record<string, Draft>;
  } catch {
    return {};
  }
}

/** The workspace the drafts belong to: the open one, or the migrated one before the registry has answered. */
const draftOwner = (): string => activeId() ?? LEGACY_WORKSPACE;

const initialDraft: Draft = readDrafts()[LEGACY_WORKSPACE] ?? { shared: "", repos: {} };

const state = createRoot(() => {
  const [shared, setShared] = createSignal(initialDraft.shared);
  const [repos, setRepos] = createSignal<Record<string, string>>(initialDraft.repos);
  const [amend, setAmend] = createSignal(false);
  const [history, setHistory] = createSignal<string[]>(readJson(KEY_HISTORY, [], isStrings).slice(0, HISTORY_LIMIT));
  /** Set after a failed validation so the field can show its error until the next keystroke. */
  const [invalid, setInvalid] = createSignal<ReadonlySet<string>>(new Set<string>());
  // The registry answers after this module loaded: switch to the draft of the workspace that is actually open.
  createEffect(
    on(activeId, (id) => {
      if (!id) return;
      const d = readDrafts()[id] ?? { shared: "", repos: {} };
      setShared(d.shared);
      setRepos(d.repos);
    }),
  );
  return { shared, setShared, repos, setRepos, amend, setAmend, history, setHistory, invalid, setInvalid };
});

const persistDraft = () => {
  const drafts = readDrafts();
  const owner = draftOwner();
  delete drafts[owner];
  const next = { ...drafts, [owner]: { shared: state.shared(), repos: state.repos() } };
  const kept = Object.fromEntries(Object.entries(next).slice(-MAX_DRAFT_WORKSPACES));
  writeStored(KEY_DRAFT, JSON.stringify(kept));
};

/** The key used in {@link invalidFields}: a repo id, or this for the shared field. */
export const SHARED_FIELD = "*";

/** Shared or per-repo messages; the choice lives in the workspace settings so the Changes tree sees the same value. */
export const messageMode = workspaceMessageMode;
export function setMessageMode(mode: MessageMode): void {
  const ws = workspace();
  state.setInvalid(new Set<string>());
  if (ws && ws.settings.messageMode !== mode) void saveWorkspace({ ...ws, settings: { ...ws.settings, messageMode: mode } });
}

export const sharedMessage = state.shared;
export function setSharedMessage(text: string): void {
  state.setShared(text);
  clearInvalid(SHARED_FIELD);
  persistDraft();
}

export const repoMessage = (repoId: string): string => state.repos()[repoId] ?? "";
export const repoMessages = state.repos;
export function setRepoMessage(repoId: string, text: string): void {
  state.setRepos((all) => ({ ...all, [repoId]: text }));
  clearInvalid(repoId);
  persistDraft();
}

export const amend = state.amend;
export const setAmend = state.setAmend;

export const messageHistory = state.history;

export const invalidFields = state.invalid;
export function markInvalid(fields: readonly string[]): void {
  state.setInvalid(new Set(fields));
}
function clearInvalid(field: string): void {
  if (!state.invalid().has(field)) return;
  state.setInvalid((s) => new Set([...s].filter((f) => f !== field)));
}

/** Records committed messages in the history and clears their drafts; a shared draft is kept while some repo still failed. */
export function messagesSent(sent: readonly { repoId: string; message: string }[], mode: MessageMode, allDone: boolean): void {
  let history = state.history();
  for (const { message } of sent) history = pushHistory(history, message);
  state.setHistory(history);
  writeStored(KEY_HISTORY, JSON.stringify(history));
  if (mode === "shared") {
    if (allDone) state.setShared("");
  } else state.setRepos((all) => Object.fromEntries(Object.entries(all).filter(([id]) => !sent.some((s) => s.repoId === id))));
  if (allDone) state.setAmend(false);
  persistDraft();
}

/** Test hook: forget all in-memory and stored state. */
export function resetMessageState(): void {
  state.setShared("");
  state.setRepos({});
  state.setAmend(false);
  state.setHistory([]);
  state.setInvalid(new Set<string>());
}
