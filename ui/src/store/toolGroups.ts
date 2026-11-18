import { isExitPlan, type ThinkingItem, type ToolItem, type TranscriptRow } from "./agent-reducer";
import type { ToolKind } from "./agent-types";

/**
 * Compact tool activity: the steps the agent takes between two pieces of prose (reads, searches, commands, edits, MCP calls, its
 * thinking, the requests that were already settled) fold into ONE quiet row, like the Claude desktop app. Pure functions: the
 * transcript turns the reducer's rows into display rows with `groupRows`, and the group row reads its summary from `tallyOf`.
 *
 * What never folds: the person's messages, the agent's prose, a request that waits for the person (permission, question, plan
 * approval), the plan list, errors, notes, turn markers, and delegation (`Agent`/`Task` calls, which keep their own row).
 */

/** The verbs a group row counts in. `edit` covers edits, moves and deletes ("changed 3 files"). */
export type ActivityVerb = "read" | "search" | "exec" | "edit" | "fetch" | "mcp" | "other";
export const VERB_ORDER: readonly ActivityVerb[] = ["read", "search", "exec", "edit", "fetch", "mcp", "other"];

const VERB_OF: Record<ToolKind, ActivityVerb> = { read: "read", search: "search", exec: "exec", edit: "edit", move: "edit", delete: "edit", fetch: "fetch", mcp: "mcp", think: "other", other: "other" };
export const verbOf = (kind: ToolKind): ActivityVerb => VERB_OF[kind] ?? "other";

/** The state of a group, worst first: the person is asked > a step failed or was blocked > work goes on > done. */
export type GroupState = "waiting" | "failed" | "running" | "done";

export interface GroupTally {
  /** Calls per verb, in `VERB_ORDER` (verbs with no call are left out). */
  verbs: { verb: ActivityVerb; n: number }[];
  calls: number;
  failed: number;
  /** Denied by the person or refused by a rule (a hard stop, an ask-instead-of-block card answered no). */
  blocked: number;
  /** Seconds of thinking in the group (closed blocks with a known end). */
  thoughtSec: number;
}

export interface ToolGroup {
  /** `group:` + the key of the first member: stable while the group grows at its end. */
  key: string;
  members: TranscriptRow[];
  tally: GroupTally;
  state: GroupState;
  /** The newest step (the live line while the group runs). */
  latest: TranscriptRow;
}

/** A display row: a reducer row, or a group of them (`group` set; `item` is then the newest member's, so "what is last" still reads). */
export type DisplayRow = TranscriptRow & { group?: ToolGroup };

const DELEGATION = new Set(["Agent", "Task"]);
export const isDelegation = (tool: ToolItem): boolean => DELEGATION.has(tool.name);

/** May this row fold into a group? Tool calls (not delegation), thinking, and requests that are settled (not a plan approval). */
export function groupable(row: TranscriptRow): boolean {
  const item = row.item;
  switch (item.type) {
    case "tool":
      return !isDelegation(item) && row.children.length === 0 && row.notes.length === 0;
    case "thinking":
      return true;
    case "permission":
      return !!item.outcome && !isExitPlan(item.intent);
    default:
      return false;
  }
}

/** Seconds a closed thinking block lasted (0 when its end is unknown or it was under a second). */
export const thoughtSeconds = (th: ThinkingItem): number => (th.done && th.endTs !== undefined && th.endTs > th.ts ? Math.round((th.endTs - th.ts) / 1000) : 0);

export function tallyOf(members: readonly TranscriptRow[]): GroupTally {
  const counts = new Map<ActivityVerb, number>();
  let calls = 0;
  let failed = 0;
  let blocked = 0;
  let thoughtSec = 0;
  const deniedTools = new Set<string>();
  for (const { item } of members) {
    if (item.type === "tool") {
      calls++;
      const verb = verbOf(item.toolKind);
      counts.set(verb, (counts.get(verb) ?? 0) + 1);
      if (item.status === "error") failed++;
      else if (item.status === "denied") {
        blocked++;
        deniedTools.add(item.toolId);
      }
    } else if (item.type === "thinking") thoughtSec += thoughtSeconds(item);
  }
  // A refused request whose call is not in the group (or never reported a result) still counts as blocked, once.
  for (const { item } of members) if (item.type === "permission" && item.outcome === "deny" && !deniedTools.has(item.toolId)) blocked++;
  return { verbs: VERB_ORDER.filter((v) => counts.has(v)).map((verb) => ({ verb, n: counts.get(verb)! })), calls, failed, blocked, thoughtSec };
}

export function stateOf(members: readonly TranscriptRow[], tally: GroupTally, waitingTools: ReadonlySet<string>): GroupState {
  if (members.some(({ item }) => item.type === "tool" && item.status === "running" && waitingTools.has(item.toolId))) return "waiting";
  if (tally.failed + tally.blocked > 0) return "failed";
  if (members.some(({ item }) => (item.type === "tool" && item.status === "running") || (item.type === "thinking" && !item.done))) return "running";
  return "done";
}

/**
 * Folds runs of groupable rows into groups. `waitingTools` are the calls a pending request asks about (their group says it waits).
 * A run without a single tool call (thinking only) is not a group: its rows stay as they are. Linear in the number of rows.
 */
export function groupRows(rows: readonly TranscriptRow[], waitingTools: ReadonlySet<string> = new Set()): DisplayRow[] {
  const out: DisplayRow[] = [];
  let run: TranscriptRow[] = [];
  const flush = () => {
    if (run.some((r) => r.item.type === "tool")) {
      const tally = tallyOf(run);
      const latest = run[run.length - 1]!;
      out.push({ key: `group:${run[0]!.key}`, item: latest.item, children: [], notes: [], group: { key: `group:${run[0]!.key}`, members: run, tally, state: stateOf(run, tally, waitingTools), latest } });
    } else out.push(...run);
    run = [];
  };
  for (const row of rows) {
    if (groupable(row)) run.push(row);
    else {
      flush();
      out.push(row);
    }
  }
  flush();
  return out;
}

/** The calls of a group that start expanded: the ones that failed or were blocked (failures are never hidden). */
export const failingKeys = (group: ToolGroup): string[] => group.members.filter(({ item }) => item.type === "tool" && (item.status === "error" || item.status === "denied")).map((r) => r.key);

/** Does a group start expanded? When something in it failed, was blocked or waits for the person; a finished or running one is folded. */
export const openByDefault = (group: ToolGroup): boolean => group.state === "failed" || group.state === "waiting";
