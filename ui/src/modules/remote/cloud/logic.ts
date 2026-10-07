import { t, type MessageKey } from "../../../i18n";
import type { CloudRun, ErrorCode, RelayCheck, StepName } from "./types";
import { ERROR_CODES } from "./types";

export const FREE_DAILY_FRAMES = 100_000;
export const FRAMES_WARN_AT = 0.5;

/** `remote.cloud.err.<code>`: Rust sends codes only, the UI owns the words. */
export function errorText(code: string): string {
  return (ERROR_CODES as readonly string[]).includes(code) ? t(`remote.cloud.err.${code}` as MessageKey) : t("remote.cloud.err.unknown", { code });
}

export function errorCodeOf(e: unknown): string {
  return typeof e === "object" && e && "code" in e ? String((e as { code: unknown }).code) : "unknown";
}
export const errorDetailOf = (e: unknown): string | null => (typeof e === "object" && e && "detail" in e && (e as { detail: unknown }).detail != null ? String((e as { detail: unknown }).detail) : null);

/** Cloudflare Worker script name: lowercase a-z0-9-, 1 to 63 characters, no leading or trailing dash. */
export type NameProblem = "empty" | "length" | "chars" | "dash";
export function nameProblem(name: string): NameProblem | null {
  if (!name) return "empty";
  if (name.length > 63) return "length";
  if (!/^[a-z0-9-]+$/.test(name)) return "chars";
  if (name.startsWith("-") || name.endsWith("-")) return "dash";
  return null;
}
export const NAME_PROBLEM_KEY: Record<NameProblem, MessageKey> = {
  empty: "remote.cloud.name.empty",
  length: "remote.cloud.name.length",
  chars: "remote.cloud.name.chars",
  dash: "remote.cloud.name.dash",
};

export function randomHex(n: number): string {
  const bytes = new Uint8Array(Math.ceil(n / 2));
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, n);
}
export const defaultWorkerName = (): string => `intely-relay-${randomHex(12)}`;
/** A custom name without a 12 character hex run is easy to guess; the public URL is enumerable. */
export const isGuessableName = (name: string): boolean => !/[0-9a-f]{12}/.test(name);

export const hostPreview = (name: string, subdomain: string | null): string => `${name || "<name>"}.${subdomain ?? "<your-subdomain>"}.workers.dev`;

export type NameCheck = "free" | "mine" | "foreign" | "unknown";
/** `unknown` is treated exactly like `foreign` (4.12.8); a dirty kit needs the phrase as well. */
export const needsOverwritePhrase = (check: NameCheck, kitDirtyFiles: number): boolean => check === "foreign" || check === "unknown" || kitDirtyFiles > 0;
export const overwritePhrase = (name: string): string => `overwrite ${name}`;

export type DeployBlock = "ack" | "unverified" | "name" | "overwrite";
/** The Deploy button is enabled only when this returns null (checked again in Rust). Comparisons are exact and case-sensitive. */
export function deployBlock(i: {
  ack: boolean;
  typed: string;
  typedOverwrite: string;
  workerName: string;
  nameCheck: NameCheck;
  kitDirtyFiles: number;
  /** The dry run could not verify the bundled modules: the user has to acknowledge that too (Rust refuses without it). */
  needsUnverifiedAck?: boolean;
  ackUnverified?: boolean;
}): DeployBlock | null {
  if (!i.ack) return "ack";
  if (i.needsUnverifiedAck && !i.ackUnverified) return "unverified";
  if (i.typed !== i.workerName) return "name";
  if (needsOverwritePhrase(i.nameCheck, i.kitDirtyFiles) && i.typedOverwrite !== overwritePhrase(i.workerName)) return "overwrite";
  return null;
}

export const hostOf = (url: string): string => {
  try {
    return new URL(url.replace(/^ws(s?):/, "http$1:")).host.toLowerCase();
  } catch {
    return "";
  }
};
/** Switching to another host unpairs every phone (passkeys and the address are bound to the host). */
export const hostChanges = (current: string, target: string): boolean => hostOf(current) !== hostOf(target);

/** Only `https://dash.cloudflare.com/...` is ever shown as the sign-in URL, and never as a link. */
export function safeLoginUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "dash.cloudflare.com" ? url : null;
  } catch {
    return null;
  }
}

export const groupHex = (hex: string): string => hex.replace(/(.{4})(?=.)/g, "$1 ");

export function framesWarn(frames: number): boolean {
  return frames >= FREE_DAILY_FRAMES * FRAMES_WARN_AT;
}

export const bytesText = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Log pane ring: 3000 lines or 512 KB, whichever is hit first. */
export const LOG_MAX_LINES = 3000;
export const LOG_MAX_BYTES = 512 * 1024;
export function ringAppend(lines: string[], more: string[]): string[] {
  let out = lines.concat(more);
  if (out.length > LOG_MAX_LINES) out = out.slice(out.length - LOG_MAX_LINES);
  let bytes = 0;
  let keepFrom = out.length;
  for (let i = out.length - 1; i >= 0; i--) {
    bytes += out[i].length + 1;
    if (bytes > LOG_MAX_BYTES) break;
    keepFrom = i;
  }
  return keepFrom > 0 ? out.slice(keepFrom) : out;
}

export const STEP_KEY: Record<StepName, MessageKey> = {
  stage: "remote.cloud.step.stage",
  config: "remote.cloud.step.config",
  deploy: "remote.cloud.step.deploy",
  parse: "remote.cloud.step.parse",
  secrets: "remote.cloud.step.secrets",
  health: "remote.cloud.step.health",
  verify: "remote.cloud.step.verify",
  record: "remote.cloud.step.record",
};
/** Steps where "Retry from this step" is safe (idempotent). */
export const RETRYABLE: StepName[] = ["deploy", "secrets", "health", "verify"];

export function failedStep(run: CloudRun | null): StepName | null {
  return run?.steps.find((s) => s.status === "failed")?.step ?? null;
}

export const VERDICT_KEY: Record<RelayCheck["verdict"], MessageKey> = {
  ok: "remote.cloud.verdict.ok",
  observed: "remote.cloud.verdict.observed",
  hashMismatch: "remote.cloud.verdict.hashMismatch",
  badSignature: "remote.cloud.verdict.badSignature",
  keyMismatch: "remote.cloud.verdict.keyMismatch",
  rollback: "remote.cloud.verdict.rollback",
  missing: "remote.cloud.verdict.missing",
};
export const verdictTone = (v: RelayCheck["verdict"]): "ok" | "warn" | "danger" => (v === "ok" ? "ok" : v === "observed" ? "warn" : "danger");

/** Whether the "Use this relay now" button may be enabled after a check (the Mac re-checks at apply time). */
export const verdictAllowsApply = (v: RelayCheck["verdict"], custom: boolean): boolean => v === "ok" || (custom && v === "observed");

export const staleCheck = (checkedAtSec: number, nowMs: number): boolean => nowMs - checkedAtSec * 1000 > 24 * 3600 * 1000;

/** Lines of a run's log with the sequence number of the first kept line (the ring drops from the front). */
export interface LogState {
  base: number;
  lines: string[];
}
export const emptyLog = (): LogState => ({ base: 0, lines: [] });
/** Idempotent: a chunk seen twice (event plus catch-up fetch) changes nothing. The UI never unmasks; it shows lines as received. */
export function applyLogChunk(s: LogState, c: { startSeq: number; lines: string[]; reset: boolean }): LogState {
  const cur = c.reset ? emptyLog() : s;
  const idx = c.startSeq - cur.base;
  if (idx < 0 && c.startSeq + c.lines.length <= cur.base) return cur;
  const from = Math.max(0, idx);
  const incoming = idx < 0 ? c.lines.slice(-idx) : c.lines;
  if (from > cur.lines.length) return cur; // a gap: wait for the catch-up fetch
  const merged = cur.lines.slice(0, from).concat(incoming);
  const kept = ringAppend([], merged);
  return { base: cur.base + (merged.length - kept.length), lines: kept };
}

import { locale } from "../../../i18n";
/** `2026-10-04, 12:01` in the current language (dates and times always through Intl). */
export const whenText = (unixSec: number): string => new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(unixSec * 1000);

export type CustomUrlProblem = "empty" | "syntax" | "scheme" | "ip" | "extra";
/** Early client-side look at a bring-your-own URL; Rust applies the full table (4.12.5). `ws://` is loopback only. */
export function customUrlProblem(raw: string): CustomUrlProblem | null {
  const v = raw.trim();
  if (!v) return "empty";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "syntax";
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "wss:" && !(u.protocol === "ws:" && local)) return "scheme";
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return "extra";
  if (!local && (/^\d+(\.\d+){0,3}$/.test(u.hostname) || u.hostname.startsWith("["))) return "ip";
  return null;
}
export const PUBKEY_RE = /^[A-Za-z0-9_-]{43}$/;
