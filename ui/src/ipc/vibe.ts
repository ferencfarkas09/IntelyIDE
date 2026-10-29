// IPC of the vibe coder toolkit (`src-tauri/src/modules/vibe.rs`): the secret masker for text that goes into a prompt, the
// Setup doctor's tool probes and the CLAUDE.md plan of the Project notes panel. All three only read. In a plain browser
// (and in tests) the mock in `mock/vibe.ts` answers; tests can swap the whole thing with `setVibeIpc`.
import { call } from "./rpc";
import { createMockVibe, maskLocally } from "./mock/vibe";

export type SetupStatus = "ok" | "warn" | "missing" | "notChecked";

/** Hand-mirrored from `crates/gitx/src/setup.rs` (camelCase). */
export interface SetupCheck {
  id: string;
  status: SetupStatus;
  version: string | null;
  path: string | null;
  /** `tooOld`, `noVersion`, `noAdb`, `notConfigured`. */
  reason: string | null;
  optional: boolean;
}

/** Hand-mirrored from `crates/files/src/claude_notes.rs` (camelCase). */
export interface NoteFile {
  scope: "user" | "project";
  dirIndex: number | null;
  rel: string;
  path: string;
  size: number;
  text: string;
  length: number;
  shortened: boolean;
}

export interface NotesPlan {
  files: NoteFile[];
  total: number;
  fileMax: number;
  totalMax: number;
  userMax: number;
  leftOut: string[];
}

export interface VibeIpc {
  /** Every secret shape replaced by `***` (the Run panel's masker plus the secret scanner's redaction). */
  maskText(text: string): Promise<string>;
  setupChecks(): Promise<SetupCheck[]>;
  /** What a Claude run on these repositories (in this order) would be told from CLAUDE.md files. */
  projectNotes(repoIds: string[]): Promise<NotesPlan>;
}

const inTauri = (): boolean => typeof window !== "undefined" && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

const tauriVibe: VibeIpc = {
  // never let unmasked text through: if the backend cannot answer, the local masker still runs
  maskText: (text) => call<string>("vibe_mask_text", { text }).catch(() => maskLocally(text)),
  setupChecks: () => call("vibe_setup_checks"),
  projectNotes: (repoIds) => call("vibe_project_notes", { repoIds }),
};

let override: VibeIpc | undefined;
let mock: VibeIpc | undefined;
export const setVibeIpc = (api: VibeIpc | undefined): void => void (override = api);

export function vibeIpc(): VibeIpc {
  if (override) return override;
  if (inTauri()) return tauriVibe;
  return (mock ??= createMockVibe());
}
