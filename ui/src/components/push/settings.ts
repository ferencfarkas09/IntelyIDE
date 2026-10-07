import { createRoot, createSignal } from "solid-js";
import type { TagsMode } from "../../ipc";
import { readStored, writeStored } from "../../ui-kit";

const KEY = "intely.push.options";

/**
 * Only the harmless options survive a restart. "Run Git hooks" off and "Push all tags" apply to the session in which
 * the user chose them, so a later push never skips hooks or publishes tags without the dialog showing it.
 */
interface Stored {
  tags: TagsMode;
  previewNonProtected: boolean;
}

const DEFAULTS: Stored = { tags: "none", previewNonProtected: true };

function load(): Stored {
  const raw = readStored(KEY);
  if (!raw) return DEFAULTS;
  try {
    const v = JSON.parse(raw) as Partial<Stored>;
    return {
      tags: v.tags === "follow" ? v.tags : "none",
      previewNonProtected: typeof v.previewNonProtected === "boolean" ? v.previewNonProtected : DEFAULTS.previewNonProtected,
    };
  } catch {
    return DEFAULTS;
  }
}

const state = createRoot(() => {
  const initial = load();
  const [tags, setTags] = createSignal<TagsMode>(initial.tags);
  const [runHooks, setRunHooks] = createSignal(true);
  const [previewNonProtected, setPreview] = createSignal(initial.previewNonProtected);
  return { tags, setTags, runHooks, setRunHooks, previewNonProtected, setPreview };
});

const persist = () => writeStored(KEY, JSON.stringify({ tags: state.tags() === "all" ? "none" : state.tags(), previewNonProtected: state.previewNonProtected() }));

export const pushTags = state.tags;
export const setPushTags = (v: TagsMode) => (state.setTags(v), persist());
export const runGitHooks = state.runHooks;
export const setRunGitHooks = (v: boolean) => (state.setRunHooks(v), persist());
export const previewNonProtected = state.previewNonProtected;
export const setPreviewNonProtected = (v: boolean) => (state.setPreview(v), persist());
