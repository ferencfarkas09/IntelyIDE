import type { Component, KindFilter, LicenseGroup } from "./types";

export interface LicenseQuery {
  query?: string;
  /** A chosen license id; empty or undefined = all. */
  license?: string;
  kind?: KindFilter;
}

const KIND_OF: Record<Exclude<KindFilter, "all">, Component["kind"][]> = {
  rust: ["cargo"],
  npm: ["npm"],
  fonts: ["font"],
};

const haystack = (c: Component): string => [c.name, c.version, ...c.chosen, c.expression, ...c.copyright].join("\n").toLowerCase();

/** Case-insensitive substring match; whitespace-separated tokens are AND-ed. Input is never turned into a regular expression. */
export function filterComponents(components: readonly Component[], q: LicenseQuery): Component[] {
  const tokens = (q.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const kinds = q.kind && q.kind !== "all" ? KIND_OF[q.kind] : undefined;
  return components.filter((c) => {
    if (kinds && !kinds.includes(c.kind)) return false;
    if (q.license && !c.chosen.includes(q.license)) return false;
    if (tokens.length === 0) return true;
    const h = haystack(c);
    return tokens.every((tok) => h.includes(tok));
  });
}

/** Counts per chosen license id, count descending then id. A dual-chosen component counts under each id. */
export function groupByLicense(components: readonly Component[]): LicenseGroup[] {
  const counts = new Map<string, number>();
  for (const c of components) for (const id of new Set(c.chosen)) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}
