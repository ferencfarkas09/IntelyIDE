import { batch, createSignal } from "solid-js";

/**
 * A run on its way. The person pressed Start and the host has not answered yet (the Rewind snapshots, the agent and its first message
 * take a while on a busy Mac), or it refused. It lives in this window only and gives way to the real run when the host answers.
 */
export interface StartingRun {
  key: string;
  /** What the person typed: the card shows it. */
  prompt: string;
  /** The prompt as it goes to the host, attachments included: what "Edit and retry" puts back. */
  retryPrompt: string;
  repoIds: string[];
  /** `auto`, or the name of the role. */
  role: string;
  startedAt: number;
  /** The dialog has given way to this card, so it is in the lists. A card that was never shown is dropped quietly when the host refuses: the dialog says why. */
  shown: boolean;
  /** The host refused. The card stays until the person edits and retries or dismisses it. */
  failure?: { code?: string; message: string };
}

export type StartingSpec = Pick<StartingRun, "prompt" | "retryPrompt" | "repoIds" | "role"> & { shown?: boolean; startedAt?: number };

const [list, setList] = createSignal<StartingRun[]>([]);
const [front, setFront] = createSignal<string | null>(null);
let counter = 0;

/** Newest first, like the runs. Only the shown ones are meant for the lists. */
export const startingRuns = (): StartingRun[] => list().filter((s) => s.shown);
/** The key of the card that fills the middle of the screen, if any. */
export const startingInFront = front;
export const startingRun = (key: string | null): StartingRun | undefined => (key ? list().find((s) => s.key === key) : undefined);

export function beginStarting(spec: StartingSpec): string {
  const key = `starting-${++counter}`;
  setList((all) => [{ key, prompt: spec.prompt, retryPrompt: spec.retryPrompt, repoIds: [...spec.repoIds], role: spec.role, startedAt: spec.startedAt ?? Date.now(), shown: spec.shown ?? false }, ...all]);
  return key;
}

/** The dialog gave way: this card is in the lists from now on. */
export function showStarting(key: string): void {
  setList((all) => all.map((s) => (s.key === key ? { ...s, shown: true } : s)));
}

export const setStartingFront = setFront;

/** The host answered: the card is gone (the caller takes over the selection). */
export function endStarting(key: string): void {
  batch(() => {
    setList((all) => all.filter((s) => s.key !== key));
    if (front() === key) setFront(null);
  });
}

/** The host refused. A card that is shown keeps the reason; one that never was shown disappears (the dialog still has the reason). */
export function failStarting(key: string, failure: { code?: string; message: string }): void {
  const card = startingRun(key);
  if (!card) return;
  if (!card.shown) return endStarting(key);
  setList((all) => all.map((s) => (s.key === key ? { ...s, failure } : s)));
}

export function resetStarting(): void {
  batch(() => {
    setList([]);
    setFront(null);
  });
}
