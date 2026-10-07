import { call, subscribe } from "./rpc";
import type { RepoId, Unsubscribe } from "./index";

export interface SearchOptions {
  /** Defaults to every repo of the workspace. */
  repoIds?: RepoId[];
  regex?: boolean;
  caseSensitive?: boolean;
  /** Path glob limiting the files searched (for example everything under src with a .ts extension). */
  glob?: string;
}

export interface SearchHit {
  repoId: RepoId;
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based column of the match start. */
  col: number;
  preview: string;
}

export interface SearchBatch {
  searchId: string;
  hits: SearchHit[];
  /** The last batch of a search carries `done` (also sent for a cancelled search). */
  done: boolean;
  /** The hit limit was reached and the search stopped early. */
  truncated?: boolean;
  /** Why a repo (or the whole search) could not be searched, for example an invalid regex. */
  error?: string;
  /** A one-line hint sent with the last batch, e.g. that ripgrep is missing and `git grep` ran. */
  notice?: string;
}

export interface SearchIpc {
  start(query: string, opts?: SearchOptions): Promise<{ searchId: string }>;
  cancel(searchId: string): Promise<void>;
  onResults(cb: (batch: SearchBatch) => void): Unsubscribe;
}

export function createTauriSearch(): SearchIpc {
  return {
    start: (query, opts) => call("search_start", { query, opts }),
    cancel: (searchId) => call("search_cancel", { searchId }),
    onResults: (cb) => subscribe("search:results", cb),
  };
}
