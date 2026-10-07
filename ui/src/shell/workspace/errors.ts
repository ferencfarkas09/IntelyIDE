import { t, type MessageKey } from "../../i18n";
import { toEngineError } from "../../ipc/rpc";
import type { BusyKind } from "../../ipc/workspaces";

/**
 * Rust sends codes and data, never English ((design notes: workspaces-spec) 8.1): this table is the one place that turns an
 * `EngineError.code` into a catalog key. A code that is not listed falls back to `ws.error.generic` with the raw message.
 */
const ERROR_KEYS = {
  duplicateName: "ws.error.duplicateName",
  invalidName: "ws.error.invalidName",
  invalidColor: "ws.error.invalidColor",
  limitReached: "ws.error.limitReached",
  registryBusy: "ws.error.registryBusy",
  pinned: "ws.error.pinned",
  workspaceNotFound: "ws.error.workspaceNotFound",
  workspaceActive: "ws.error.workspaceActive",
  invalidWorkspace: "ws.error.invalidWorkspace",
  workspaceFileMissing: "ws.error.workspaceFileMissing",
  workspaceBusy: "ws.error.workspaceBusy",
  workspaceSwitching: "ws.error.workspaceSwitching",
  staleEpoch: "ws.error.staleEpoch",
  tokenUsed: "ws.error.tokenUsed",
  tokenExpired: "ws.error.tokenExpired",
  wrongPurpose: "ws.error.wrongPurpose",
  readOnly: "ws.error.readOnly",
  testJail: "ws.error.testJail",
  bareRepo: "ws.error.bareRepo",
  alreadyInWorkspace: "ws.error.alreadyInWorkspace",
  pathNotValidated: "ws.error.pathNotValidated",
  pathInvalid: "ws.error.pathInvalid",
  notFound: "ws.error.notFound",
  volumeMissing: "ws.error.volumeMissing",
  notADirectory: "ws.error.notADirectory",
  notAFile: "ws.error.notAFile",
  permissionDenied: "ws.error.permissionDenied",
  nativeFailed: "ws.error.nativeFailed",
  tooBroad: "ws.error.tooBroad",
  initTooBroad: "ws.error.initTooBroad",
  scanTooBroad: "ws.error.scanTooBroad",
  noWorkspace: "ws.error.noWorkspace",
  trustRequired: "ws.error.trustRequired",
  riskChanged: "ws.error.riskChanged",
  otherInstance: "ws.error.otherInstance",
  io: "ws.error.io",
  registryCorrupt: "welcome.problem.corrupt",
  unsupportedVersion: "welcome.problem.newer",
  legacyUnreadable: "welcome.problem.legacy",
  notGit: "picker.kind.notGit",
} as const satisfies Record<string, MessageKey>;

export type KnownErrorCode = keyof typeof ERROR_KEYS;

export const isKnownErrorCode = (code: string): code is KnownErrorCode => Object.prototype.hasOwnProperty.call(ERROR_KEYS, code);

/** The catalog key of an error code (`ws.error.generic` when the code is not in the table). */
export function workspaceErrorKey(code: string): MessageKey {
  return isKnownErrorCode(code) ? ERROR_KEYS[code] : "ws.error.generic";
}

/** The user-facing text of any rejection of a workspace or picker command. Call it at render time so it follows the language. */
export function workspaceErrorText(e: unknown): string {
  const err = toEngineError(e);
  return isKnownErrorCode(err.code) ? t(ERROR_KEYS[err.code]) : t("ws.error.generic", { reason: err.message });
}

/** Codes that mean "nothing was stopped or changed": a failed switch with one of these leaves the page as it is. */
export const BEFORE_TEARDOWN: ReadonlySet<string> = new Set([
  "workspaceBusy",
  "workspaceNotFound",
  "invalidWorkspace",
  "workspaceFileMissing",
  "workspaceSwitching",
  "pinned",
  "registryBusy",
  "noWorkspace",
  "staleEpoch",
  "unimplemented",
]);

const WARNING_KEYS = {
  agentsStuck: "switch.warning.agentsStuck",
  runnerStuck: "switch.warning.runnerStuck",
  termStuck: "switch.warning.termStuck",
  checksStuck: "switch.warning.checksStuck",
  previewStuck: "switch.warning.previewStuck",
  filesStuck: "switch.warning.filesStuck",
  mongoStuck: "switch.warning.mongoStuck",
  registryWriteFailed: "switch.warning.registryWriteFailed",
} as const satisfies Record<string, MessageKey>;

/** Text of a `SwitchWarning.code`, or `undefined` for a code this build does not know (it is then not shown). */
export function switchWarningText(code: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(WARNING_KEYS, code) ? t(WARNING_KEYS[code as keyof typeof WARNING_KEYS]) : undefined;
}

/** One line per busy kind for the guard dialog: `guard.blocker.<kind>`. `labels` is data (names), joined by the caller. */
export const BLOCKER_KEYS = {
  gitRun: "guard.blocker.gitRun",
  gitOp: "guard.blocker.gitOp",
  agent: "guard.blocker.agent",
  devServer: "guard.blocker.devServer",
  check: "guard.blocker.check",
  terminal: "guard.blocker.terminal",
  preview: "guard.blocker.preview",
  mongo: "guard.blocker.mongo",
  unsaved: "guard.blocker.unsaved",
} as const satisfies Record<BusyKind, MessageKey>;
