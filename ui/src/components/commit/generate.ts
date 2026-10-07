import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import { ipc } from "../../ipc";
import type { MessageCheck, MessageStyle } from "../../ipc/graph";
import { checkedFiles } from "../../store/selection";
import { workspace } from "../../store/workspace";
import { toast } from "../../ui-kit";
import { t } from "../../i18n";
import { messageMode, setRepoMessage, setSharedMessage, sharedMessage } from "./messageState";

/** Tooltip of the Generate button. */
export const generateTooltip = () => t("commit.generateTip");

const errorText = (err: unknown): string | undefined => (err instanceof Error ? err.message : (err as { message?: string } | null)?.message);

/** A message with the `Extended English:` paragraph is checked against that layout, anything else as plain Conventional Commits. */
export const styleOf = (message: string): MessageStyle => (/^Extended English:/m.test(message) ? "extended" : "conventional");

/** The engine's verdict on a message, 250 ms after the last keystroke; null while empty, loading or unavailable. */
export function createMessageCheck(message: Accessor<string>): Accessor<MessageCheck | null> {
  const [check, setCheck] = createSignal<MessageCheck | null>(null);
  createEffect(() => {
    const text = message();
    if (!text.trim()) return setCheck(null);
    const timer = setTimeout(() => {
      ipc.graph.validateMessage(text, styleOf(text)).then(
        (result) => text === message() && setCheck(result),
        () => setCheck(null),
      );
    }, 250);
    onCleanup(() => clearTimeout(timer));
  });
  return check;
}

/**
 * Adds the Extended English sections to the message: an empty message becomes the whole template, a message with text keeps its
 * own text and gets the sections underneath. Resolves false when the sections are already there.
 */
export async function insertExtendedTemplate(current: string): Promise<string | null> {
  if (styleOf(current) === "extended") return null;
  const subject = current.split("\n", 1)[0].trim() || undefined;
  const template = await ipc.graph.messageTemplate("extended", subject);
  if (!current.trim()) return template;
  const sections = template.slice(template.indexOf("\n"));
  return `${current.trimEnd()}${sections}`;
}

/** The Extended English button and command: puts the sections into the shared message. */
export async function applyExtendedTemplate(): Promise<void> {
  try {
    const text = await insertExtendedTemplate(sharedMessage());
    if (text === null) toast.info(t("commit.toast.already"), t("commit.toast.alreadyDesc"));
    else setSharedMessage(text);
  } catch (err) {
    toast.error(t("commit.toast.templateFail"), errorText(err));
  }
}

const [busy, setBusy] = createSignal(false);
/** True while a draft is being written. */
export const drafting = busy;

const [busyRepos, setBusyRepos] = createSignal<ReadonlySet<string>>(new Set());
/** True while a message for this one repo is being drafted. */
export const draftingRepo = (repoId: string): boolean => busyRepos().has(repoId);
/** Tooltip of the Generate button of one repo block / one repo message field. */
export const generateRepoTooltip = (name: string) => t("commit.generateRepoTip", { name });

/**
 * Drafts the message of ONE repo from its ticked changes: the Generate button of a repo block in the Changes tree and the one
 * of that repo's own message field. Per-repo mode fills that repo's field, shared mode lets the shared message take this repo's
 * draft. Several repos can be drafting at once.
 */
export async function draftRepoMessage(repoId: string): Promise<void> {
  if (busyRepos().has(repoId)) return;
  const paths = checkedFiles(repoId);
  if (!paths.length) return void toast.info(t("commit.toast.nothing"), t("commit.toast.nothingDesc"));
  setBusyRepos((s) => new Set(s).add(repoId));
  try {
    const draft = await ipc.graph.draftMessageDetailed(repoId, paths.map((path) => ({ path })));
    if (messageMode() === "perRepo") setRepoMessage(repoId, draft.message);
    else setSharedMessage(draft.message);
    if (draft.source === "template" && draft.note) toast.info(t("commit.toast.template"), draft.note);
  } catch (err) {
    toast.error(t("commit.toast.draftFail"), errorText(err));
  } finally {
    setBusyRepos((s) => {
      const next = new Set(s);
      next.delete(repoId);
      return next;
    });
  }
}

/**
 * Asks `ipc.graph.draftMessage` for the ticked changes: the shared message takes the draft of the repo with the most ticked files,
 * in per-repo mode every repo with ticked files gets its own. The draft replaces what is in the field.
 */
export async function draftMessage(): Promise<void> {
  if (busy()) return;
  const picked = (workspace()?.repos ?? []).map((r) => ({ id: r.id, paths: checkedFiles(r.id) })).filter((r) => r.paths.length > 0);
  if (!picked.length) return void toast.info(t("commit.toast.nothing"), t("commit.toast.nothingDesc"));
  setBusy(true);
  try {
    const ask = (r: (typeof picked)[number]) => ipc.graph.draftMessageDetailed(r.id, r.paths.map((path) => ({ path })));
    if (messageMode() === "perRepo") {
      const drafts = await Promise.all(picked.map(async (r) => [r.id, await ask(r)] as const));
      for (const [id, draft] of drafts) setRepoMessage(id, draft.message);
    } else {
      const main = picked.reduce((a, b) => (b.paths.length > a.paths.length ? b : a));
      const draft = await ask(main);
      setSharedMessage(draft.message);
      if (draft.source === "template" && draft.note) toast.info(t("commit.toast.template"), draft.note);
    }
  } catch (err) {
    toast.error(t("commit.toast.draftFail"), errorText(err));
  } finally {
    setBusy(false);
  }
}
