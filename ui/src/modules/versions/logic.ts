// The arithmetic and bookkeeping of the Versions panel. The files themselves are edited by crates/versions; this only
// decides what the new value of a field is when a button is pressed, and which fields differ from what is on disk.
import type { Bump, Change, Field, RepoVersions } from "./types";

/** Pending values by field id. A field that is not in the map keeps what is on disk. */
export type Edits = Record<string, string>;

interface Parsed {
  nums: number[];
  pre: string;
}

function parse(value: string): Parsed | undefined {
  const core = value.split("+")[0];
  const at = core.indexOf("-");
  const head = at < 0 ? core : core.slice(0, at);
  const parts = head.split(".");
  if (parts.length > 4 || !parts.every((p) => /^\d{1,9}$/.test(p))) return undefined;
  return { nums: parts.map(Number), pre: at < 0 ? "" : core.slice(at + 1) };
}

/**
 * The next version, the way `npm version` counts: a pre-release (`1.2.3-beta.1`) is finished by a patch, and by a minor
 * or major only when nothing is below it; build metadata (`+x`) is dropped. A two-part version (`1.2`) keeps two parts
 * for a minor or major bump and gains a third for a patch. Returns undefined for something that is not numeric or has
 * more than three parts.
 */
export function bumpVersion(value: string, how: Bump): string | undefined {
  const p = parse(value);
  if (!p || p.nums.length > 3) return undefined;
  const len = p.nums.length;
  const [a, b = 0, c = 0] = p.nums;
  const take = (x: number[], min: number): string => x.slice(0, Math.max(len, min)).join(".");
  if (how === "patch") return p.pre ? take([a, b, c], len) : [a, b, c + 1].join(".");
  if (how === "minor") return p.pre && c === 0 ? take([a, b, 0], 2) : take([a, b + 1, 0], 2);
  return p.pre && b === 0 && c === 0 ? take([a, 0, 0], 1) : take([a + 1, 0, 0], 1);
}

/** The next build number: an integer plus one, or the last part of a dotted one (`1.4` → `1.5`). Exact for any length. */
export function bumpBuild(value: string): string | undefined {
  if (!/^\d+(\.\d+)*$/.test(value)) return undefined;
  const parts = value.split(".");
  const last = parts.length - 1;
  parts[last] = String(BigInt(parts[last]) + 1n);
  return parts.join(".");
}

/**
 * A version of 0.0.0 is what a package that is never published carries (the packages of a workspace, tooling folders).
 * The buttons leave it alone, so "All repositories: Patch" does not turn those into 0.0.1; typing into the row still can.
 */
export const isPlaceholder = (field: Field): boolean => field.role === "version" && field.value === "0.0.0";

/** The value of a field after pressing a button, or undefined when the button does not apply to it. */
export function nextValue(field: Field, how: Bump | "build"): string | undefined {
  if (how === "build") return field.role === "build" ? bumpBuild(field.value) : undefined;
  return field.role === "version" && !isPlaceholder(field) ? bumpVersion(field.value, how) : undefined;
}

/** Edits for every field of the repo a button applies to; fields it does not apply to are left as they are. */
export function bumpRepo(repo: RepoVersions, how: Bump | "build", edits: Edits): Edits {
  const out = { ...edits };
  for (const f of repo.fields) {
    const v = nextValue(f, how);
    if (v !== undefined && v !== f.value) out[f.id] = v;
  }
  return out;
}

/** Every version field of the repo set to one value (build numbers and 0.0.0 placeholders are left alone). */
export function setAllVersions(repo: RepoVersions, value: string, edits: Edits): Edits {
  const out = { ...edits };
  for (const f of repo.fields) if (f.role === "version" && !isPlaceholder(f)) out[f.id] = value;
  return out;
}

/** The changes to send: only fields whose pending value differs from the disk and is not empty. */
export function changesOf(repo: RepoVersions, edits: Edits): Change[] {
  const out: Change[] = [];
  for (const f of repo.fields) {
    const to = edits[f.id]?.trim();
    if (to && to !== f.value) out.push({ id: f.id, from: f.value, to });
  }
  return out;
}

export const countChanges = (repos: RepoVersions[], edits: Record<string, Edits>): number => repos.reduce((n, r) => n + changesOf(r, edits[r.repoId] ?? {}).length, 0);

/** The distinct version values of a repo, most written first: one value means its files agree. Placeholders do not count. */
export function versionValues(repo: RepoVersions): string[] {
  const seen = new Map<string, number>();
  for (const f of repo.fields) if (f.role === "version" && !isPlaceholder(f)) seen.set(f.value, (seen.get(f.value) ?? 0) + 1);
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
}

const plainNumber = (part: string): boolean => part === "0" || /^[1-9]\d*$/.test(part);

/** The same check the Rust side makes (`valid` in crates/versions), so a bad value is marked before anything is sent. */
export function validValue(field: Field, value: string): boolean {
  const plus = !(field.kind === "pbxproj" || field.kind === "pubspec");
  if (field.role === "version") {
    if (field.numeric) return value.length <= 16 && value.split(".").length <= 2 && value.split(".").every(plainNumber);
    return /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(value) && (plus || !value.includes("+"));
  }
  return value.length > 0 && value.length <= 16 && value.split(".").every(plainNumber) && (!field.numeric || !value.includes("."));
}
