// The buttons and the payload of a permission card, derived from the Rust verdict. Shared by the Claude gate and the mock adapter so the
// e2e flow through the mock exercises the same rules.
import { redact } from './redact.js';
import type { PermissionMode, PermissionOption, PolicyDecision } from './types.js';

/**
 * `allow_run` ("allow always in this session", D10) is offered only when Rust attached a `sessionAllow` offer to its Ask; the allow
 * itself is derived and kept by the host, never by the sidecar. ExitPlanMode never gets it (its card is built by `planPayload`).
 */
export function offeredOptions(d: Pick<PolicyDecision, 'sessionAllow'>): PermissionOption[] {
  return ['allow_once', ...(d.sessionAllow ? (['allow_run'] as const) : []), 'deny'];
}

/** The working modes an ExitPlanMode approval may continue in (Bypass is never offered there, D2). */
export const PLAN_MODES: readonly PermissionMode[] = ['ask', 'edit', 'automatic'];
/** The plan text on the approval card: redacted, at most 64 KiB. */
export const PLAN_MAX_BYTES = 64 * 1024;

/** Cuts a string to at most `max` UTF-8 bytes without leaving half a character. */
export function cutBytes(text: string, max: number): { text: string; cut: boolean } {
  if (Buffer.byteLength(text) <= max) return { text, cut: false };
  return { text: Buffer.from(text).subarray(0, max).toString('utf8').replace(/�+$/, ''), cut: true };
}

/** `plan`, `planTruncated` and `modes` of an ExitPlanMode `permission.request`: the full text, redacted first and cut second. */
export function planPayload(raw: string): { plan: string; planTruncated?: true; modes: PermissionMode[] } {
  const { text, cut } = cutBytes(redact(raw), PLAN_MAX_BYTES);
  return { plan: text, ...(cut ? { planTruncated: true as const } : {}), modes: [...PLAN_MODES] };
}
