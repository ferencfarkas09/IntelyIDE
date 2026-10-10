import type { RepoState, ServerCfg, ServerDraft, ServerStatus, ServerView, SetupEvent, SetupOptions, SetupStepName } from "../../ipc/servers";

export const MAX_AGENTS_LIMIT = 64;
export const DEFAULT_ROOT = "~/work";
export const DEFAULT_MAX_AGENTS = 4;

export type ChipId = "ready" | "needsSetup" | "unreachable" | "unchecked";
export type ChipTone = "ok" | "warn" | "danger" | "neutral";

/** The one word on a server card: what the last check found. */
export function statusChip(status: ServerStatus | undefined): { id: ChipId; tone: ChipTone } {
  if (!status) return { id: "unchecked", tone: "neutral" };
  if (!status.reachable) return { id: "unreachable", tone: "danger" };
  return status.ready ? { id: "ready", tone: "ok" } : { id: "needsSetup", tone: "warn" };
}

export type CheckId = "node" | "claude" | "git" | "bundle" | "sdk";
export interface CheckRow {
  id: CheckId;
  /** ok = installed and usable, missing = not there, unknown = no check yet or the server is unreachable. */
  state: "ok" | "missing" | "unknown";
  version?: string;
}

/** The checklist under a card: Node, Claude Code, git, the agent bundle, the Agent SDK. */
export function checklist(status: ServerStatus | undefined): CheckRow[] {
  const ids: CheckId[] = ["node", "claude", "git", "bundle", "sdk"];
  if (!status || !status.reachable) return ids.map((id) => ({ id, state: "unknown" }));
  const row = (id: CheckId, ok: boolean, version: string | undefined): CheckRow => ({ id, state: ok ? "ok" : "missing", ...(version ? { version } : {}) });
  return [
    row("node", status.node.ok, status.node.version),
    row("claude", !!(status.claude.path || status.claude.version), status.claude.version),
    row("git", !!(status.git.path || status.git.version), status.git.version),
    row("bundle", status.bundle.ok, status.bundle.version),
    row("sdk", status.sdk.ok, status.sdk.version),
  ];
}

/** Claude is installed but not signed in on the server (or the check could not tell): show how to sign in once. */
export const needsClaudeLogin = (status: ServerStatus | undefined): boolean =>
  !!status && status.reachable && !!(status.claude.path || status.claude.version) && (status.claude.loggedIn === false || status.claude.loggedIn === null);

/** The command that signs Claude in on the server. */
export const loginCommand = (cfg: Pick<ServerCfg, "destination" | "port">): string => `${sshPrefix(cfg)} claude`.replace(/^ssh /, "ssh -t ");

/** `ssh [-p port] destination`, as the Rust side builds it for the terminal. */
export const sshPrefix = (cfg: Pick<ServerCfg, "destination" | "port">): string => (cfg.port ? `ssh -p ${cfg.port} ${cfg.destination}` : `ssh ${cfg.destination}`);

/** Free slots on a server for new runs. */
export const freeSlots = (v: Pick<ServerView, "cfg" | "running">): number => Math.max(0, v.cfg.maxAgents - v.running);

export const platformText = (status: ServerStatus | undefined): string => (status?.reachable ? [status.os, status.arch].filter(Boolean).join(" ") : "");

// ---- the form ----

export interface ServerFormValues {
  id?: string;
  name: string;
  destination: string;
  /** Text, so an empty field means "the ssh default". */
  port: string;
  root: string;
  maxAgents: string;
  enabled: boolean;
}

export type FormField = "name" | "destination" | "port" | "root" | "maxAgents";
export type FormErrorKey =
  | "servers.err.name"
  | "servers.err.nameTaken"
  | "servers.err.destination"
  | "servers.err.destinationChars"
  | "servers.err.port"
  | "servers.err.root"
  | "servers.err.maxAgents";
export type FormErrors = Partial<Record<FormField, FormErrorKey>>;

export const emptyForm = (): ServerFormValues => ({ name: "", destination: "", port: "", root: DEFAULT_ROOT, maxAgents: String(DEFAULT_MAX_AGENTS), enabled: true });

export const formFromCfg = (c: ServerCfg): ServerFormValues => ({ id: c.id, name: c.name, destination: c.destination, port: c.port ? String(c.port) : "", root: c.root, maxAgents: String(c.maxAgents), enabled: c.enabled });

const whole = (s: string): number | undefined => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : undefined);

/** Checks the form before it goes to the backend (which checks again and has the last word). */
export function validateForm(f: ServerFormValues, others: readonly Pick<ServerCfg, "id" | "name">[]): FormErrors {
  const errors: FormErrors = {};
  const name = f.name.trim();
  if (!name) errors.name = "servers.err.name";
  else if (others.some((o) => o.id !== f.id && o.name.trim().toLowerCase() === name.toLowerCase())) errors.name = "servers.err.nameTaken";
  const dest = f.destination.trim();
  if (!dest) errors.destination = "servers.err.destination";
  else if (dest.startsWith("-") || /\s/.test(dest)) errors.destination = "servers.err.destinationChars";
  if (f.port.trim() !== "") {
    const port = whole(f.port);
    if (port === undefined || port < 1 || port > 65535) errors.port = "servers.err.port";
  }
  if (!f.root.trim()) errors.root = "servers.err.root";
  const max = whole(f.maxAgents);
  if (max === undefined || max < 1 || max > MAX_AGENTS_LIMIT) errors.maxAgents = "servers.err.maxAgents";
  return errors;
}

/** The backend's field a rejection code belongs to, so its message shows under that field. */
export const FIELD_OF_CODE: Record<string, FormField> = {
  invalidName: "name",
  duplicateName: "name",
  invalidDestination: "destination",
  invalidPort: "port",
  invalidRoot: "root",
  invalidMaxAgents: "maxAgents",
};

/** The request for `servers_save` from a form that passed `validateForm`. */
export function toDraft(f: ServerFormValues): ServerDraft {
  const port = f.port.trim() === "" ? undefined : Number(f.port.trim());
  return { ...(f.id ? { id: f.id } : {}), name: f.name.trim(), destination: f.destination.trim(), ...(port !== undefined ? { port } : {}), root: f.root.trim(), maxAgents: Number(f.maxAgents.trim()), enabled: f.enabled };
}

// ---- setup ----

/** Everything on, except what the server already has. Nothing is known before the first check, so all of it is on. */
export function defaultSetupOptions(status: ServerStatus | undefined): SetupOptions {
  if (!status || !status.reachable) return { installNode: true, installBundle: true, installSdk: true, installClaude: true };
  return { installNode: !status.node.ok, installBundle: !status.bundle.ok, installSdk: !status.sdk.ok, installClaude: !(status.claude.path || status.claude.version) };
}

/** An update, not a first setup: something is installed already but not everything works. */
export const setupLabelId = (status: ServerStatus | undefined): "setUp" | "update" => (status?.reachable && (status.node.ok || status.bundle.ok || status.sdk.ok) ? "update" : "setUp");

export const STEP_ORDER: readonly SetupStepName[] = ["probe", "prepare", "node", "bundle", "sdk", "claude", "verify"];

export interface StepRow {
  step: SetupStepName;
  /** The latest state of the step; "started" is a step in progress. */
  state: SetupEvent["state"];
  /** Every message of the step, in the order they came. */
  lines: string[];
}

/** The events of one setup grouped by step, in the order the steps first appeared. */
export function stepRows(events: readonly SetupEvent[]): StepRow[] {
  const rows: StepRow[] = [];
  for (const e of events) {
    let row = rows.find((r) => r.step === e.step);
    if (!row) rows.push((row = { step: e.step, state: e.state, lines: [] }));
    // "info" is a note on a step in progress: it does not change the state.
    if (e.state !== "info") row.state = e.state;
    if (e.message) row.lines.push(e.message);
  }
  return rows;
}

export type SetupOutcome = { phase: "idle" } | { phase: "running" } | { phase: "ok" } | { phase: "failed"; step: SetupStepName; message: string };

export function setupOutcome(events: readonly SetupEvent[], running: boolean, error?: string): SetupOutcome {
  const failed = events.find((e) => e.state === "failed");
  if (failed) return running ? { phase: "running" } : { phase: "failed", step: failed.step, message: failed.message };
  if (running) return { phase: "running" };
  if (error) return { phase: "failed", step: events[events.length - 1]?.step ?? "probe", message: error };
  return events.length > 0 ? { phase: "ok" } : { phase: "idle" };
}

/** True once a step failed, even while the backend is still closing up. */
export const hasFailed = (events: readonly SetupEvent[]): boolean => events.some((e) => e.state === "failed");

// ---- repositories ----

export type RepoKind = "ready" | "notGit" | "missing";
export const repoKind = (r: RepoState): RepoKind => (!r.exists ? "missing" : r.isGit ? "ready" : "notGit");

/** Workspace repository ids whose folder is missing on the server, paired with the answers by position. */
export function missingRepoIds(repoIds: readonly string[], states: readonly RepoState[]): string[] {
  return repoIds.filter((_, i) => states[i] && repoKind(states[i]) === "missing");
}
