// Pure helpers of the connection-test stepper, the diagnosis view and the host-key dialogs. No ipc, no DOM.
import { fmt, t, type MessageKey } from "../../../i18n";
import type { Diagnosis, HostKeyView, StepId, StepState, TestStep } from "../../../ipc/mongo";

export const STEP_ORDER: StepId[] = ["config", "tunnel", "dns", "connect", "tls", "auth", "permissions"];

/** Number of `fix<n>` strings per diagnosis code (Appendix B2). The catalog completeness test holds both sides to it. */
export const DIAG_FIXES = {
  "config.invalid": 1, "config.fileMissing": 2, "config.pemInvalid": 2, "config.unsupportedOption": 1, "config.needsSecret": 1,
  "config.plainRemote": 2, "config.tlsRelaxRefused": 2,
  "tunnel.noSsh": 2, "tunnel.auth": 3, "tunnel.hostKeyUnknown": 2, "tunnel.hostKeyChanged": 3, "tunnel.hostKeyUnscannable": 2,
  "tunnel.dns": 2, "tunnel.network": 2, "tunnel.forwardingDisabled": 1, "tunnel.targetRefused": 2, "tunnel.notAllowed": 2,
  "tunnel.keyFile": 2, "tunnel.keyPerms": 1, "tunnel.passphrase": 1, "tunnel.interactive": 2, "tunnel.ipv6": 1, "tunnel.dropped": 1,
  "dns.notFound": 2, "dns.srv": 2, "dns.txt": 2,
  "net.refused": 3, "net.timeout": 2, "net.unreachable": 2, "net.reset": 2,
  "tls.unknownIssuer": 2, "tls.hostname": 4, "tls.expired": 2, "tls.clientCertRequired": 2, "tls.serverNotTls": 2, "tls.serverRequiresTls": 1, "tls.pem": 1,
  "auth.failed": 3, "auth.mechanism": 1, "auth.source": 1, "auth.x509Subject": 1,
  "authz.listDatabases": 2, "authz.collection": 1, "authz.command": 1,
  "select.noServer": 3, "select.replicaSetName": 1, "select.direct": 1, "select.memberUnreachable": 2,
  "timeout.total": 1,
  other: 2,
} as const;
export type DiagCode = keyof typeof DIAG_FIXES;
export const DIAG_CODES = Object.keys(DIAG_FIXES) as DiagCode[];
export const ATLAS_HINTS = ["atlas.networkAccess", "atlas.paused", "atlas.databaseUser", "atlas.authSource", "atlas.clusterName"] as const;

export const isDiagCode = (code: string): code is DiagCode => Object.prototype.hasOwnProperty.call(DIAG_FIXES, code);
/** An unknown code (a newer Rust build) falls back to `other` instead of showing a raw key. */
export const diagCodeOf = (code: string): DiagCode => (isDiagCode(code) ? code : "other");
export const diagKey = (code: DiagCode, part: "title" | "cause" | `fix${number}`) => `mongoDiag.${code}.${part}` as MessageKey;

export interface DiagParams {
  host?: string;
  hints: (typeof ATLAS_HINTS)[number][];
}
/** The Rust side sends `(key, value)` pairs: `host` once, `hint` per Atlas hint. Unknown keys are ignored. */
export function diagParams(d: Pick<Diagnosis, "params">): DiagParams {
  const out: DiagParams = { hints: [] };
  for (const [k, v] of d.params ?? []) {
    if (k === "host" && out.host === undefined) out.host = v;
    else if (k === "hint" && (ATLAS_HINTS as readonly string[]).includes(v) && !out.hints.includes(v as never)) out.hints.push(v as never);
  }
  return out;
}

export interface StepRow {
  id: StepId;
  state: StepState;
  ms: number;
  note?: string | null;
}

/**
 * The rows the stepper shows: every step in order (Tunnel only when a tunnel is configured), missing ones pending. A
 * step after a failed one is never shown ok or running: it is skipped, so TLS, sign-in and permissions are never green
 * for a step that was not reached.
 */
export function visibleSteps(steps: readonly TestStep[] | undefined, opts: { tunnel: boolean }): StepRow[] {
  const byId = new Map((steps ?? []).map((s) => [s.id, s]));
  const rows: StepRow[] = [];
  let failed = false;
  for (const id of STEP_ORDER) {
    if (id === "tunnel" && !opts.tunnel && !byId.has("tunnel")) continue;
    const s = byId.get(id);
    let state: StepState = s?.state ?? "pending";
    if (failed && state !== "skipped") state = "skipped";
    if (state === "failed") failed = true;
    rows.push({ id, state, ms: s?.ms ?? 0, note: s?.note });
  }
  return rows;
}

export type Overall = "idle" | "running" | "ok" | "warn" | "failed" | "cancelled";
export function overall(rows: readonly StepRow[], o: { running: boolean; cancelled?: boolean; ok?: boolean }): Overall {
  if (o.cancelled) return "cancelled";
  if (rows.some((r) => r.state === "failed")) return "failed";
  if (o.running) return "running";
  if (o.ok === undefined && rows.every((r) => r.state === "pending")) return "idle";
  if (o.ok === false) return "failed";
  return rows.some((r) => r.state === "warn") ? "warn" : o.ok ? "ok" : "idle";
}

export const stepLabel = (id: StepId) => t(`mongoDiag.step.${id}` as MessageKey);
export const stateLabel = (s: StepState) => t(`mongoDiag.state.${s}` as MessageKey);

export function formatMs(ms: number): string {
  return ms < 1000 ? t("mongoDiag.stepper.time.ms", { ms: fmt.number(Math.max(0, Math.round(ms))) }) : t("mongoDiag.stepper.time.s", { s: fmt.number(Math.round(ms / 100) / 10) });
}

/** Maps a warning code from the test report onto a message key; unknown codes show the code itself. */
export function warningKey(code: string): { key: MessageKey; params?: Record<string, string> } {
  const c = code.toLowerCase();
  if (c.includes("plain")) return { key: "mongoDiag.warning.plainRemote" as MessageKey };
  if (c.includes("relax")) return { key: "mongoDiag.warning.relaxed" as MessageKey };
  if (c.includes("writ") || c.includes("elevated")) return { key: "mongoDiag.warning.writer" as MessageKey };
  return { key: "mongoDiag.warning.other" as MessageKey, params: { code } };
}

// ---- host key ---------------------------------------------------------------------------------------------------

export type HostKeyMode = "unknown" | "changed" | "unscannable";
export const hostKeyMode = (view: Pick<HostKeyView, "status"> | undefined, unscannable?: boolean): HostKeyMode => (unscannable ? "unscannable" : view?.status === "changed" ? "changed" : "unknown");

/** `SHA256:abc...` in groups of four characters for reading aloud and comparing; the copy button copies the original. */
export function fingerprintGroups(fp: string): { prefix: string; groups: string[] } {
  const i = fp.indexOf(":");
  const prefix = i > 0 ? fp.slice(0, i + 1) : "";
  const body = i > 0 ? fp.slice(i + 1) : fp;
  return { prefix, groups: body.match(/.{1,4}/g) ?? [] };
}

/** True when the typed text is exactly the host (the forget flow: a deliberate act, no case or space slack). */
export const forgetConfirmed = (typed: string, host: string) => host.length > 0 && typed === host;

/** The shell command shown for an unscannable bastion. Only used for display and copy, after the host passed the charset check. */
export function manualSshCommand(host: string): string | undefined {
  return /^[A-Za-z0-9._-]{1,253}$/.test(host) && !host.startsWith("-") ? `ssh ${host}` : undefined;
}

// ---- allow-list dialogs -----------------------------------------------------------------------------------------

export type AllowProblem = "format" | "linkLocal";

/**
 * Advisory check of a `host:port` before it is offered for the allow-list (Rust validates again). No IPv6 literals in v1.
 * Link-local and metadata addresses (169.254.0.0/16, fe80::/10) are refused, also in the odd spellings
 * ("0xA9FEA9FE", "2852039166", octal parts) that some resolvers still turn into 169.254.169.254.
 */
export function allowProblem(entry: string): AllowProblem | undefined {
  const m = /^([A-Za-z0-9._-]{1,253}):(\d{1,5})$/.exec(entry.trim());
  if (!m) return /^\[?fe80:/i.test(entry.trim()) ? "linkLocal" : "format";
  const [, host, port] = m;
  const p = Number(port);
  if (p < 1 || p > 65535 || host.startsWith("-")) return "format";
  if (/^(0x[0-9a-f]+|[0-9]+)(\.(0x[0-9a-f]+|[0-9]+))*$/i.test(host)) {
    // A purely numeric host is an IP literal. Only the canonical dotted decimal form is judged by its value; the odd
    // spellings (hex, octal, a single big number) are refused because they can hide 169.254.169.254.
    const parts = host.split(".");
    const canonical = parts.length === 4 && parts.every((x) => /^(0|[1-9]\d{0,2})$/.test(x) && Number(x) <= 255);
    if (!canonical || (parts[0] === "169" && parts[1] === "254")) return "linkLocal";
  }
  if (host.toLowerCase() === "metadata.google.internal") return "linkLocal";
  return undefined;
}
