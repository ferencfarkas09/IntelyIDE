import type { McpExposure, PermissionMode } from "./agent-types";

/** The five run modes from the strictest to the loosest; the index is the policy ladder (`PermissionMode::strictness` in Rust). */
export const MODE_ORDER: readonly PermissionMode[] = ["readOnly", "ask", "edit", "automatic", "bypass"];

/** The working modes the Plan approval card offers when it leaves plan mode (never Bypass). */
export const AFTER_PLAN: readonly PermissionMode[] = ["ask", "edit", "automatic"];

export const strictness = (mode: PermissionMode): number => MODE_ORDER.indexOf(mode);
/** Automatic and Bypass never ask; nothing waits for a card in them. */
export const isUnattended = (mode: PermissionMode): boolean => mode === "automatic" || mode === "bypass";

/** The mode that applies now: what the session reported (`session.info.effective`), else what the host recorded. */
export const effectiveMode = (a: { permission: PermissionMode; effective?: { permission: PermissionMode } | null }): PermissionMode => a.effective?.permission ?? a.permission;

/** The servers of a run that would run tools which change things without asking in Automatic and Bypass (MCP spec 13 item 9). */
export function exposureOf(mcp: readonly McpExposure[] | undefined): { count: number; names: string; secretNames: string } {
  const exposed = (mcp ?? []).filter((m) => m.exposed > 0);
  return {
    count: exposed.reduce((n, m) => n + m.exposed, 0),
    names: exposed.map((m) => m.name).join(", "),
    secretNames: (mcp ?? []).filter((m) => m.hasSecretEnv).map((m) => m.name).join(", "),
  };
}
