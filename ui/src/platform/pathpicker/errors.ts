import type { EngineError } from "../../bindings";
import { t, type MessageKey } from "../../i18n";
import type { Picked } from "../../ipc/picker";

const KEYS: Record<string, MessageKey> = {
  notFound: "picker.err.notFound",
  volumeMissing: "picker.err.volume",
  notADirectory: "picker.err.notDir",
  notAFile: "picker.err.notFile",
  pathInvalid: "picker.err.invalid",
  testJail: "picker.err.jail",
  tokenExpired: "picker.err.expired",
  tokenUsed: "picker.err.expired",
  pathNotValidated: "picker.err.expired",
  busy: "picker.err.busy",
  nativeFailed: "picker.nativeFailed",
  tooBroad: "picker.error.tooBroad",
  initTooBroad: "picker.init.tooBroad",
  readOnly: "picker.init.readOnly",
};

export const asEngineError = (e: unknown): EngineError =>
  typeof e === "object" && e !== null && typeof (e as EngineError).code === "string"
    ? (e as EngineError)
    : { code: "io", message: e instanceof Error ? e.message : String(e) };

/** The translated sentence for a picker error. Rust sends codes, never English. */
export function errorText(e: EngineError): string {
  const key = KEYS[e.code];
  if (key) return t(key);
  return t("picker.err.io", { reason: e.message });
}

/** Display name of the repository a linked worktree belongs to: `/x/api/.git` -> `api`. */
export function mainName(main: string | null): string {
  if (!main) return "";
  const parts = main.split("/").filter(Boolean);
  if (parts.at(-1) === ".git") parts.pop();
  return parts.at(-1) ?? main;
}

export const basename = (p: string) => p.split("/").filter(Boolean).at(-1) ?? "/";

/** What a picked item turns into when the user confirms: the root for a subfolder or a `.git` folder, itself otherwise. */
export function effective(p: Picked): Picked | null {
  switch (p.kind) {
    case "subfolder":
    case "gitDir":
      return p.root ?? null;
    case "bare":
    case "notGit":
      return null;
    default:
      return p;
  }
}
