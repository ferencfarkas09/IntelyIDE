// The JSON inside the Noise channel (crates/remote/src/wire.rs). Types come from the generated bindings of the Mac side
// (type-only imports, no runtime code from the IDE webview); decoding is fail-closed like the Rust side.
import type { AgentEvent, Capability, ClientMsg, ReqCard, RunCard, ServerMsg } from "@ui/bindings/remote";
import { fromUtf8, utf8 } from "../noise/bytes";

export type { AgentEvent, Capability, ClientMsg, ReqCard, RunCard, ServerMsg };
export const PROTOCOL_VERSION = 1;
export const MAX_SERVER_MSG = 64 * 1024;

export type PairMsg = { t: "hello"; name: string } | { t: "passkeyRegister"; credentialId: string; publicKey: string };
export type PairReply = { t: "accepted"; deviceId: string; deviceToken: string; capability: Capability; macName: string } | { t: "rejected"; reason: string } | { t: "welcome"; bundlePub: string };

export const encode = (msg: ClientMsg | PairMsg): Uint8Array => utf8(JSON.stringify({ ...msg, v: PROTOCOL_VERSION }));

function decode(bytes: Uint8Array): Record<string, unknown> | null {
  if (bytes.length > MAX_SERVER_MSG) return null;
  try {
    const v = JSON.parse(fromUtf8(bytes));
    if (!v || typeof v !== "object" || Array.isArray(v) || v.v !== PROTOCOL_VERSION || typeof v.t !== "string") return null;
    delete v.v;
    return v;
  } catch {
    return null;
  }
}

const SERVER_TAGS = new Set(["hello", "snapshot", "event", "runSnapshot", "reqNew", "reqResolved", "capabilityChanged", "ack", "stepUpChallenge", "diff", "pong", "revoked", "bye", "welcome"]);

export function decodeServer(bytes: Uint8Array): ServerMsg | null {
  const v = decode(bytes);
  return v && SERVER_TAGS.has(v.t as string) ? (v as unknown as ServerMsg) : null;
}

export function decodePairReply(bytes: Uint8Array): PairReply | null {
  const v = decode(bytes);
  if (!v) return null;
  if (v.t === "accepted" && typeof v.deviceId === "string" && typeof v.deviceToken === "string") return v as unknown as PairReply;
  if (v.t === "rejected") return v as unknown as PairReply;
  if (v.t === "welcome" && typeof v.bundlePub === "string") return v as unknown as PairReply;
  return null;
}

/** Escapes invisible and bidi control characters so a command cannot hide what it does (remote-plan S3). */
export function visible(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);
}

let opCounter = 0;
/** A fresh idempotency key for one command (the Mac dedupes on it). */
export function newOpId(): string {
  const r = new Uint8Array(9);
  crypto.getRandomValues(r);
  return `${Date.now().toString(36)}-${++opCounter}-${Array.from(r, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
