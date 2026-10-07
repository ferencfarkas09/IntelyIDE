import { REPO_PALETTE } from "../../ui-kit/repoPalette";
import type { Picked } from "../../ipc/picker";
import type { RepoRedeem } from "../../ipc/workspaces";
import { workspaceNameFrom } from "./flows";
import type { PickedItem } from "./pickerBridge";

/*
 * The pure part of the New workspace and Scan dialogs: rows being assembled (display name, badge, colour, trust), duplicate
 * detection by identity and path, default names that stay apart when two folders share a basename, and the request that
 * goes to `workspaces_create` ((design notes: workspaces-spec) 3.4, 3.5).
 */

export const MAX_REPOS = 100;
export const MAX_NAME = 60;

export interface RepoDraft {
  /** Stable key of the row (the token of the pick it came from). */
  key: string;
  picked: PickedItem;
  name: string;
  badge: string;
  color: string;
  /** The user typed the name/badge: automatic disambiguation leaves it alone. */
  nameEdited: boolean;
  badgeEdited: boolean;
  trusted: boolean;
  /** A create attempt reported this row's token as unusable. */
  failed: boolean;
}

export type NameProblem = "empty" | "long" | "taken";

/** Why a workspace name cannot be used, or `null`. Taken ignores case and normalisation, like Rust. */
export function nameProblem(raw: string, taken: readonly string[]): NameProblem | null {
  const name = raw.normalize("NFC").trim();
  if (!name) return "empty";
  if ([...name].length > MAX_NAME) return "long";
  const lower = name.toLocaleLowerCase();
  return taken.some((n) => n.normalize("NFC").toLocaleLowerCase() === lower) ? "taken" : null;
}

/** Initials of the words (max two), else the first two letters. */
export function badgeFromName(name: string): string {
  const words = name.trim().split(/[\s_\-./]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** The default badge of a name, or the first free variant when the initials are taken (AB, AC, AD ... then A1 ...). */
export function freeBadge(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map((b) => b.toUpperCase()));
  const base = badgeFromName(name);
  if (!used.has(base)) return base;
  const letters = [...name.toUpperCase()].filter((c) => /\p{L}/u.test(c));
  const first = letters[0] ?? base[0] ?? "?";
  for (const c of letters.slice(1)) if (!used.has(first + c)) return first + c;
  for (let n = 1; n < 100; n++) if (!used.has(`${first}${n}`)) return `${first}${n}`;
  return base;
}

/** Folder name, or `parent/name` when two rows would otherwise read the same. */
function qualified(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts.length > 1 ? `${parts.at(-2)}/${parts.at(-1)}` : (parts.at(-1) ?? path);
}

const baseOf = (p: PickedItem): string => p.name || (p.path.split("/").filter(Boolean).at(-1) ?? p.path);

/** Colour not used by the other rows (cycling the palette). */
export function freeColor(used: readonly string[]): string {
  return REPO_PALETTE.find((c) => !used.includes(c)) ?? REPO_PALETTE[used.length % REPO_PALETTE.length];
}

/** Re-derives the automatic names and badges: rows sharing a basename read `parent/name`, badges stay unique. */
export function normalize(drafts: readonly RepoDraft[]): RepoDraft[] {
  const counts = new Map<string, number>();
  for (const d of drafts) counts.set(baseOf(d.picked).toLocaleLowerCase(), (counts.get(baseOf(d.picked).toLocaleLowerCase()) ?? 0) + 1);
  const out: RepoDraft[] = [];
  for (const d of drafts) {
    const clash = (counts.get(baseOf(d.picked).toLocaleLowerCase()) ?? 0) > 1;
    const name = d.nameEdited ? d.name : clash ? qualified(d.picked.path) : baseOf(d.picked);
    const badge = d.badgeEdited ? d.badge : freeBadge(name, out.map((o) => o.badge));
    out.push({ ...d, name, badge });
  }
  return out;
}

export interface AddResult {
  drafts: RepoDraft[];
  /** Picked items that were already in the list or in the target workspace. */
  duplicates: PickedItem[];
  /** Rows beyond the limit were not added. */
  overLimit: boolean;
}

/** Appends picked folders as rows. A subfolder/.git result becomes its root; a row with the same identity or path is a duplicate. */
export function addPicked(current: readonly RepoDraft[], items: readonly PickedItem[], alreadyIn: (p: Picked) => boolean = () => false, limit = MAX_REPOS): AddResult {
  const duplicates: PickedItem[] = [];
  const list = [...current];
  let overLimit = false;
  for (const raw of items) {
    const p: PickedItem = (raw.kind === "subfolder" || raw.kind === "gitDir") && raw.root ? { ...raw.root, trusted: raw.trusted } : raw;
    if (!["repo", "worktree", "submodule"].includes(p.kind)) continue;
    if (list.some((d) => d.picked.identity === p.identity || d.picked.path === p.path) || alreadyIn(p)) {
      duplicates.push(p);
      continue;
    }
    if (list.length >= limit) {
      overLimit = true;
      continue;
    }
    list.push({
      key: p.token,
      picked: p,
      name: baseOf(p),
      badge: "",
      color: freeColor(list.map((d) => d.color)),
      nameEdited: false,
      badgeEdited: false,
      trusted: !!p.trusted,
      failed: false,
    });
  }
  return { drafts: normalize(list), duplicates, overLimit };
}

export function moveDraft(drafts: readonly RepoDraft[], key: string, delta: -1 | 1): RepoDraft[] {
  const from = drafts.findIndex((d) => d.key === key);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= drafts.length) return [...drafts];
  const next = [...drafts];
  [next[from], next[to]] = [next[to], next[from]];
  return normalize(next);
}

export const removeDraft = (drafts: readonly RepoDraft[], key: string): RepoDraft[] => normalize(drafts.filter((d) => d.key !== key));

export const patchDraft = (drafts: readonly RepoDraft[], key: string, patch: Partial<RepoDraft>): RepoDraft[] =>
  normalize(drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)));

/** Rows whose Git settings can run programs and that the user has not ticked yet. */
export const needsTrust = (d: RepoDraft): boolean => d.picked.configRisks.length > 0 && !d.trusted;

/** Two rows with the same badge text inside one workspace (a warning, not an error). */
export function duplicateBadges(drafts: readonly RepoDraft[]): Set<string> {
  const seen = new Map<string, number>();
  for (const d of drafts) seen.set(d.badge.toUpperCase(), (seen.get(d.badge.toUpperCase()) ?? 0) + 1);
  return new Set([...seen].filter(([, n]) => n > 1).map(([b]) => b));
}

export const redeemFrom = (d: RepoDraft): RepoRedeem => ({ token: d.picked.token, name: d.name.trim(), badge: d.badge.trim(), color: d.color, ...(d.trusted ? { trust: true } : {}) });

/** The workspace name suggested for a scan: the parent folder's name. */
export const suggestedName = (root: string): string => workspaceNameFrom(root.replace(/\/+$/, "").split("/").filter(Boolean).at(-1) ?? "Workspace");
