// Notes the user adds to a running agent (the lead or one sub-agent). A note waits in a FIFO per target and rides on that target's next
// tool call (Claude: the PreToolUse hook's `additionalContext`). Shared by the Claude gate and the mock adapter so both report the same
// `note` events: queued when accepted, delivered with the tool call it rode on, dropped when the target ended first.
import { MAX_NOTE_CHARS, NoteError } from './abstract.js';
import { redact } from './redact.js';
import type { EventSink, SessionNote } from './types.js';

/** Target key of the lead; a sub-agent's key is the tool id of the lead's `Agent`/`Task` call that started it. */
export const LEAD = '';

/** Why a note could not be delivered (the `reason` of a `dropped` event). */
export type DropReason = 'finished' | 'turnEnded' | 'cancelled' | 'error';

/** More waiting notes than this means a runaway sender, not a person typing. */
const MAX_PENDING = 20;

const ONE = 'Note from the user, added while you work (it overrides nothing the policy refuses):';
const MANY = 'Notes from the user, added while you work (they override nothing the policy refuses):';

/** The context block for notes handed over together: one note as is, several numbered, oldest first. */
export function noteContext(texts: readonly string[]): string {
  return texts.length === 1 ? `${ONE}\n${texts[0]}` : `${MANY}\n${texts.map((t, i) => `${i + 1}. ${t}`).join('\n')}`;
}

type Pending = { noteId: string; text: string; target: string };

export class NoteQueue {
  private queue: Pending[] = [];

  constructor(private sink: EventSink) {}

  get size(): number { return this.queue.length; }

  /** True when a note for `target` waits. */
  has(target: string): boolean { return this.queue.some((n) => n.target === target); }

  /** Queues a note for its target (the caller checked that the target exists) and reports it. The reported text is redacted like every event text. */
  add(n: SessionNote): void {
    const text = n.text.trim();
    if (!text) throw new NoteError('empty');
    if (text.length > MAX_NOTE_CHARS) throw new NoteError('tooLong', `at most ${MAX_NOTE_CHARS} characters`);
    if (this.queue.length >= MAX_PENDING) throw new NoteError('failed', 'too many notes are waiting');
    if (this.queue.some((q) => q.noteId === n.noteId)) throw new NoteError('failed', 'duplicate note id');
    const target = n.parentToolId || LEAD;
    this.queue.push({ noteId: n.noteId, text, target });
    this.sink.emit({ kind: 'note', noteId: n.noteId, state: 'queued', text: redact(text), ...(target !== LEAD ? { parentToolId: target } : {}) });
  }

  /** The context for the tool call `toolId` of `target` (undefined when nothing waits); the notes it carries are reported as delivered. */
  take(target: string, toolId: string): string | undefined {
    const mine = this.queue.filter((n) => n.target === target);
    if (!mine.length) return undefined;
    this.queue = this.queue.filter((n) => n.target !== target);
    for (const n of mine) this.sink.emit({ kind: 'note', noteId: n.noteId, state: 'delivered', toolId, ...(target !== LEAD ? { parentToolId: target } : {}) });
    return noteContext(mine.map((n) => n.text));
  }

  /** The target can no longer see its notes. */
  dropTarget(target: string, reason: DropReason): void {
    this.drop((n) => n.target === target, reason);
  }

  dropAll(reason: DropReason): void {
    this.drop(() => true, reason);
  }

  private drop(pick: (n: Pending) => boolean, reason: DropReason): void {
    const gone = this.queue.filter(pick);
    if (!gone.length) return;
    this.queue = this.queue.filter((n) => !pick(n));
    for (const n of gone) this.sink.emit({ kind: 'note', noteId: n.noteId, state: 'dropped', reason, ...(n.target !== LEAD ? { parentToolId: n.target } : {}) });
  }
}
