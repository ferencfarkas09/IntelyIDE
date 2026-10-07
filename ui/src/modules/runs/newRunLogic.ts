import type { Tier } from "@intely/protocol";
import { t, type MessageKey } from "../../i18n";
import type { ProviderEnforcement, ProviderInfo } from "../../ipc/providers";
import { modeErrorText } from "../../components/chat/modes";
import type { AgentStartRequest, AutoInfo, DelegateInfo, PermissionMode, RoleInfo } from "../../store/agent-types";
import { MODE_ORDER, strictness } from "../../store/permissionModes";
import { roleGate, roleKind, tierFor } from "../providers/enforcement";
import { STATE_CHIP } from "../providers/logic";
import { mcpRunErrorKey } from "./mcpSeam";

/** `auto`: the run starts with a lead agent and no role was picked; `role`: today's single-role run. */
export type RunMode = "auto" | "role";
/** The reserved role name of the lead of an Auto run. */
export const AUTO_ROLE = "auto";

export interface NewRunDraft {
  role: string | undefined;
  repoIds: string[];
  prompt: string;
  /** Absent means `role` (every caller from before Auto exists). */
  mode?: RunMode;
  /** The permission mode of the run (Plan, Ask, Accept edits, Automatic, Bypass). Absent: the request names none and the role's own applies. */
  permission?: PermissionMode;
  /** The MCP servers picked for the run. Absent (no picker): the request names none, which means no MCP. */
  mcpServers?: string[];
}

/**
 * The mode a new run starts with until acceptance gate AG-1 of (design notes: permission-modes-spec) 6.8 has passed. One constant: while the gate
 * has not been run or has failed, change it to "ask" and nothing else in the dialog changes.
 */
export const DEFAULT_MODE_UNTIL_AG1: PermissionMode = "automatic";

/** The nearest mode among `supported` that is not looser than `mode` (never a step up in what the agent may do); the strictest when none is. */
export function clampMode(mode: PermissionMode, supported: readonly PermissionMode[]): PermissionMode {
  if (supported.includes(mode)) return mode;
  const stricter = MODE_ORDER.filter((m) => supported.includes(m) && strictness(m) < strictness(mode));
  return stricter[stricter.length - 1] ?? MODE_ORDER.find((m) => supported.includes(m)) ?? mode;
}

/**
 * The mode a dialog opens with: a read-only role asks for Plan; else the one used last (Bypass is never a default, so it falls back to the
 * initial default), else the initial default; then the nearest one the provider supports. `supported` empty means it is not known yet.
 */
export function initialMode(last: PermissionMode | undefined, supported: readonly PermissionMode[], role?: Pick<RoleInfo, "permission">): PermissionMode {
  const wanted: PermissionMode = role?.permission === "readOnly" ? "readOnly" : last && last !== "bypass" && MODE_ORDER.includes(last) ? last : DEFAULT_MODE_UNTIL_AG1;
  return supported.length ? clampMode(wanted, supported) : wanted;
}

/** Why the Start button is inert, or undefined when the run can start. Auto needs repositories and a prompt only. */
export function startBlocker(draft: NewRunDraft, roles: readonly Pick<RoleInfo, "name">[]): string | undefined {
  if (draft.mode !== "auto" && (!draft.role || !roles.some((r) => r.name === draft.role))) return t("runs.new.pickRole");
  if (draft.repoIds.length === 0) return t("runs.new.pickRepo");
  if (draft.prompt.trim() === "") return t("runs.new.writePrompt");
}

export const toggleRepo = (repoIds: readonly string[], id: string): string[] => (repoIds.includes(id) ? repoIds.filter((x) => x !== id) : [...repoIds, id]);

/** The repos a role proposes, limited to the ones that exist in the workspace. */
export const defaultRepos = (role: Pick<RoleInfo, "defaultRepoIds"> | undefined, known: readonly string[]): string[] => (role?.defaultRepoIds ?? []).filter((id) => known.includes(id));

/** `agent_start` plus the provider the user picked for this run; absent means the role's own provider. */
export type StartRunRequest = AgentStartRequest & { provider?: string };

export interface ProviderChoice {
  id: string;
  name: string;
  tier: Tier;
  /** Selectable for this role? */
  ok: boolean;
  /** Why not, or a caution when it is allowed. */
  note?: string;
}

/**
 * The providers a run of this role can go to. Only providers that are switched on and that the roles backend can run (they offer
 * models) are listed; the role's own provider is always listed so the reason it cannot start is visible. A provider other than
 * Claude takes a role that changes files only at the write tier, or when the user allowed that provider (`roleGate`).
 */
export function providerChoices(
  role: Pick<RoleInfo, "provider" | "permission"> | undefined,
  providers: readonly (Pick<ProviderInfo, "id" | "name" | "enabled" | "state"> & { allowWeakWriter?: boolean })[],
  runnable: ReadonlySet<string>,
  enforcement: readonly ProviderEnforcement[],
): ProviderChoice[] {
  if (!role) return [];
  return providers
    .filter((p) => p.id === role.provider || (p.enabled && runnable.has(p.id)))
    .map((p): ProviderChoice => {
      const tier = tierFor(enforcement, p.id, roleKind(role.permission)).tier;
      if (!p.enabled || p.state === "off") return { id: p.id, name: p.name, tier, ok: false, note: t("runs.new.providerOff", { name: p.name }) };
      if (!runnable.has(p.id)) return { id: p.id, name: p.name, tier, ok: false, note: t("runs.new.providerNoAdapter", { name: p.name }) };
      if (p.state === "notInstalled" || p.state === "needsLogin" || p.state === "needsKey" || p.state === "needsConfirm") return { id: p.id, name: p.name, tier, ok: false, note: t("runs.new.providerState", { name: p.name, state: STATE_CHIP[p.state].label.toLowerCase() }) };
      const gate = roleGate(p.id, p.name, role.permission, tier, p.allowWeakWriter === true);
      return { id: p.id, name: p.name, tier, ok: gate.ok, ...(gate.reason ?? gate.caution ? { note: gate.reason ?? gate.caution } : {}) };
    });
}

/** The provider this run will use: the picked one while it is still a valid choice, else the role's own. */
export const chosenProvider = (picked: string | undefined, role: Pick<RoleInfo, "provider"> | undefined, choices: readonly ProviderChoice[]): string | undefined =>
  picked && choices.some((c) => c.id === picked && c.ok) ? picked : role?.provider;

/** The request for `agent_start`: `provider` is sent only when it differs from the role's, so a plain run is byte-identical to before. */
export function startRequest(draft: NewRunDraft, role: Pick<RoleInfo, "provider"> | undefined, provider: string | undefined): StartRunRequest {
  const chosen = { ...(draft.permission ? { mode: draft.permission } : {}), ...(draft.mcpServers ? { mcpServers: draft.mcpServers } : {}) };
  // Auto on Claude names no provider: the host knows the lead is a Claude agent.
  if (draft.mode === "auto") return { role: AUTO_ROLE, repoIds: draft.repoIds, prompt: draft.prompt, ...chosen };
  return { role: draft.role!, repoIds: draft.repoIds, prompt: draft.prompt, ...chosen, ...(provider && provider !== role?.provider ? { provider } : {}) };
}

/** Codes of the host's start refusals that speak about the mode; the supplier's MCP codes use the MCP catalog. */
const MODE_START_CODES = new Set(["modeNotSupported", "modeDisabled", "bypassNotConfirmed", "writeLease", "noSlot"]);
const MCP_START_CODES = new Set(["confirmationRequired", "mcpSecretMissing", "readOnly", "mcpUnavailable", "mcpUnknownServer", "keychain", "mcpBadConfig", "mcpCodeInRunDir"]);

/** What the dialog's error line says for a refused start: the mode codes in the user's words, the MCP codes from the MCP catalog, else the host's message. */
export function startErrorText(e: unknown): string {
  const err = e as { code?: string; message?: string } | null;
  const code = err?.code;
  if (code && MODE_START_CODES.has(code)) return modeErrorText(code, err?.message);
  if (code && mcpRunErrorKey && (MCP_START_CODES.has(code) || code.startsWith("mcp"))) return t(mcpRunErrorKey(code));
  return err?.message ?? String(e);
}

/** Why the chosen provider cannot start this role, or undefined. Read-only roles on an enabled provider are never blocked. */
export const providerBlocker = (provider: string | undefined, choices: readonly ProviderChoice[]): string | undefined => {
  const c = choices.find((x) => x.id === provider);
  return c && !c.ok ? c.note : undefined;
};

/** The role "Auto" means on a provider other than Claude: one agent, the neutral read-only role, no delegation ((design notes: roles-orchestration-spec) 4.2). */
export const neutralRole = <R extends Pick<RoleInfo, "name" | "permission">>(roles: readonly R[]): R | undefined => roles.find((r) => r.name === "researcher" && r.permission === "readOnly") ?? roles.find((r) => r.permission === "readOnly");

export type DelegateKind = "readOnly" | "edits" | "runsCommands" | "asks";
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

/** A delegate in one plain word: what its role lets it do. */
export function delegateKind(d: Pick<DelegateInfo, "permission" | "tools">): DelegateKind {
  if (d.permission === "readOnly") return "readOnly";
  if (d.permission === "ask") return "asks";
  const tools = d.tools ?? [];
  return tools.length > 0 && !tools.some((x) => EDIT_TOOLS.has(x)) ? "runsCommands" : "edits";
}
const KIND_KEY = { readOnly: "runs.auto.kind.readOnly", edits: "runs.auto.kind.edits", runsCommands: "runs.auto.kind.runsCommands", asks: "runs.auto.kind.asks" } as const satisfies Record<DelegateKind, MessageKey>;
export const delegateKindText = (d: Pick<DelegateInfo, "permission" | "tools">): string => t(KIND_KEY[delegateKind(d)]);

/** "researcher (read-only), developer (edits), reviewer (runs commands, asks)": the first-launch card. */
export const derivationSummary = (delegates: readonly Pick<DelegateInfo, "name" | "permission" | "tools">[]): string => delegates.map((d) => `${d.name} (${delegateKindText(d)})`).join(", ");

const REASON_KEY: Record<string, MessageKey> = {
  claudeDisabled: "runs.auto.reason.claudeOff",
  notInstalled: "runs.auto.reason.notInstalled",
  notLoggedIn: "runs.auto.reason.needsLogin",
  cliTooOld: "runs.auto.reason.cliTooOld",
  autoDisabled: "runs.auto.reason.disabled",
  delegationDisabled: "runs.auto.reason.delegationDisabled",
  canaryTripped: "runs.auto.reason.canaryTripped",
};
/** The reason Auto cannot run (a code of the host); an unknown one shows as sent. */
export const autoReasonText = (reason: string | null | undefined): string => (reason ? (reason in REASON_KEY ? t(REASON_KEY[reason]) : reason) : "");

/** Delegates worth a line on the card: the roles Auto starts with, cheapest model first is not our call (the lead chooses). */
export const hasDelegates = (info: Pick<AutoInfo, "delegates"> | undefined): boolean => (info?.delegates.length ?? 0) > 0;
