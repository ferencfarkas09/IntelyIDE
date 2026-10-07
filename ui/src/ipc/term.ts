import { Channel } from "@tauri-apps/api/core";
import type { TermEvent, TermOpened as WireOpened } from "../bindings/term";
import { call } from "./rpc";
import type { RepoId, Unsubscribe } from "./index";

export interface TermOpenOptions {
  /** Starts in the repo root. */
  repoId?: RepoId;
  /** Absolute directory; wins over `repoId`. */
  cwd?: string;
  cols: number;
  rows: number;
}

export interface TermOpened {
  termId: string;
  /** Where the shell started; the mock leaves it out. */
  cwd?: string;
}

export interface TermData {
  termId: string;
  data: string;
}

export interface TermExit {
  termId: string;
  code: number | null;
}

/**
 * A pty-backed shell per terminal. Open before you subscribe is fine: the first output is delivered after the
 * `open` promise resolved, so a caller that registers its listeners synchronously after `await open()` misses nothing.
 * Closing a terminal that is gone is not an error. Refused in the test jail outside the fixture root (`testJail`)
 * and always in read-only mode (`readOnly`).
 */
export interface TermIpc {
  open(opts: TermOpenOptions): Promise<TermOpened>;
  write(termId: string, data: string): Promise<void>;
  resize(termId: string, cols: number, rows: number): Promise<void>;
  close(termId: string): Promise<void>;
  onData(cb: (e: TermData) => void): Unsubscribe;
  onExit(cb: (e: TermExit) => void): Unsubscribe;
}

export function createTauriTerm(): TermIpc {
  const data = new Set<(e: TermData) => void>();
  const exits = new Set<(e: TermExit) => void>();
  const dispatch = (termId: string, e: TermEvent) =>
    e.kind === "data" ? data.forEach((cb) => cb({ termId, data: e.data })) : exits.forEach((cb) => cb({ termId, code: e.code }));
  return {
    async open(opts) {
      const channel = new Channel<TermEvent>();
      // The channel does not carry the terminal id; output that beats the command's reply waits for it.
      const early: TermEvent[] = [];
      let id: string | undefined;
      channel.onmessage = (e) => (id ? dispatch(id, e) : early.push(e));
      const opened = await call<WireOpened>("term_open", { opts, onEvent: channel });
      id = opened.termId;
      setTimeout(() => early.splice(0).forEach((e) => dispatch(opened.termId, e)), 0);
      return { termId: opened.termId, cwd: opened.cwd };
    },
    write: (termId, text) => call("term_write", { termId, data: text }),
    resize: (termId, cols, rows) => call("term_resize", { termId, cols, rows }),
    close: (termId) => call("term_close", { termId }),
    onData(cb) {
      data.add(cb);
      return () => data.delete(cb);
    },
    onExit(cb) {
      exits.add(cb);
      return () => exits.delete(cb);
    },
  };
}
