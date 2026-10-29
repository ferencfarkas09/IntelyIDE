// Pure helpers of the prompt library: placeholders, search, the shape of settings.json and of an import file.
import type { PromptContext, PromptsSettings, SavedPrompt, ScopedPrompt } from "./types";

export const PLACEHOLDERS = ["selection", "file", "branch", "repo"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

export const MAX_TITLE = 120;
export const MAX_BODY = 20_000;
export const MAX_TAGS = 12;
export const MAX_TAG = 32;
/** A larger library is refused on import: settings.json is not meant to hold a book. */
export const MAX_PROMPTS = 500;
export const EXPORT_FORMAT = "intelyide-prompts";

const PLACEHOLDER_RE = /\{\{\s*(selection|file|branch|repo)\s*\}\}/gi;

/** The placeholders a body uses, each once, in the order they first appear. */
export function placeholdersIn(body: string): Placeholder[] {
  const out: Placeholder[] = [];
  for (const m of body.matchAll(PLACEHOLDER_RE)) {
    const p = m[1].toLowerCase() as Placeholder;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * Fills the placeholders. A value that is not known (no file open, nothing selected) becomes a short note in angle brackets,
 * so the person sees in the prompt box what to fill in before starting the run.
 */
export function fillPrompt(body: string, ctx: PromptContext, missing: (p: Placeholder) => string = (p) => `<${p}>`): string {
  return body.replace(PLACEHOLDER_RE, (_all, name: string) => {
    const p = name.toLowerCase() as Placeholder;
    const v = ctx[p];
    if (v === undefined || v.trim() === "") return missing(p);
    return p === "selection" && v.includes("\n") ? `\n\`\`\`\n${v.replace(/\n+$/, "")}\n\`\`\`\n` : v;
  });
}

/** Prompts whose title, tags or body hold every word of the query (any case). Title matches come first. */
export function searchPrompts<T extends SavedPrompt>(list: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list.slice();
  const hay = (p: T) => `${p.title} ${p.tags.join(" ")} ${p.body}`.toLowerCase();
  const hits = list.filter((p) => words.every((w) => hay(p).includes(w)));
  const inTitle = (p: T) => words.every((w) => p.title.toLowerCase().includes(w) || p.tags.some((tag) => tag.toLowerCase().includes(w)));
  return [...hits.filter(inTitle), ...hits.filter((p) => !inTitle(p))];
}

/** Every tag of the list, sorted, once. */
export const allTags = (list: readonly SavedPrompt[]): string[] => [...new Set(list.flatMap((p) => p.tags))].sort((a, b) => a.localeCompare(b));

export const newId = (): string => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);

/** Tags as typed ("react, test  ui") -> ["react", "test", "ui"]: lower case, no duplicates, bounded. */
export function parseTags(text: string): string[] {
  return [...new Set(text.split(/[,\s]+/).map((s) => s.trim().toLowerCase().slice(0, MAX_TAG)).filter(Boolean))].slice(0, MAX_TAGS);
}

/** A prompt from untrusted JSON (settings.json, an import file), or undefined when it is not one. */
export function normalizePrompt(raw: unknown, now = Date.now()): SavedPrompt | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === "string" ? r.title.trim().slice(0, MAX_TITLE) : "";
  const body = typeof r.body === "string" ? r.body.slice(0, MAX_BODY) : "";
  if (!title || !body.trim()) return undefined;
  const tags = Array.isArray(r.tags) ? parseTags(r.tags.filter((x): x is string => typeof x === "string").join(",")) : [];
  const id = typeof r.id === "string" && /^[\w:-]{1,64}$/.test(r.id) && !r.id.startsWith("starter:") ? r.id : newId();
  const updatedAt = typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt) ? r.updatedAt : now;
  return { id, title, body, tags, updatedAt };
}

const list = (raw: unknown): SavedPrompt[] => (Array.isArray(raw) ? raw.map((x) => normalizePrompt(x)).filter((x): x is SavedPrompt => !!x).slice(0, MAX_PROMPTS) : []);

/** The `prompts` settings namespace, whatever is stored there. */
export function readSettings(raw: Record<string, unknown>): PromptsSettings {
  const repos: Record<string, SavedPrompt[]> = {};
  if (raw.repos && typeof raw.repos === "object" && !Array.isArray(raw.repos)) {
    for (const [id, v] of Object.entries(raw.repos as Record<string, unknown>)) {
      const l = list(v);
      if (l.length) repos[id] = l;
    }
  }
  return { user: list(raw.user), repos };
}

/** Replaces the prompt with the same id, or adds it at the start. */
export function upsert(prompts: readonly SavedPrompt[], p: SavedPrompt): SavedPrompt[] {
  return prompts.some((x) => x.id === p.id) ? prompts.map((x) => (x.id === p.id ? p : x)) : [p, ...prompts];
}

/** The export file: titles, bodies and tags only (no ids, no repository ids, no paths). */
export function exportJson(prompts: readonly SavedPrompt[]): string {
  return JSON.stringify({ format: EXPORT_FORMAT, version: 1, prompts: prompts.map((p) => ({ title: p.title, body: p.body, tags: p.tags })) }, null, 2);
}

/** Reads an export file (or a bare array of prompts). Every imported prompt gets a new id, so an import never overwrites. */
export function parseImport(text: string): { prompts: SavedPrompt[]; skipped: number } | { error: "json" | "shape" | "tooMany" } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: "json" };
  }
  const items = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { prompts?: unknown }).prompts) ? (raw as { prompts: unknown[] }).prompts : undefined;
  if (!items) return { error: "shape" };
  if (items.length > MAX_PROMPTS) return { error: "tooMany" };
  const now = Date.now();
  const prompts = items.map((x) => normalizePrompt(x && typeof x === "object" ? { ...(x as object), id: undefined } : x, now)).filter((x): x is SavedPrompt => !!x);
  return { prompts, skipped: items.length - prompts.length };
}

/** The repositories' own first, then the person's, then the starters: the order the picker lists them in. */
export function libraryFor(settings: PromptsSettings, repoIds: readonly string[], starters: readonly ScopedPrompt[]): ScopedPrompt[] {
  const repo = repoIds.flatMap((repoId) => (settings.repos[repoId] ?? []).map((p): ScopedPrompt => ({ ...p, scope: { kind: "repo", repoId } })));
  const user = settings.user.map((p): ScopedPrompt => ({ ...p, scope: { kind: "user" } }));
  return [...repo, ...user, ...starters];
}
