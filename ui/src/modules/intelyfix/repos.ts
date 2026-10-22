// Which repositories of the workspace a Sentry issue belongs to. Pure.

export interface RepoRef {
  id: string;
  name: string;
}

export interface FixRepos {
  /** Where the work is. */
  primary: RepoRef[];
  /** Repositories that may change with it (the backend of a front end that shows the symptom). */
  related: RepoRef[];
  /** How it was decided: the map in Settings, the only repository there is, or the likeness of the names. */
  source: "map" | "only" | "name";
}

/** `Shop-Backend`, `shop_backend` and `shopbackend` are one name. */
const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const byName = (repos: readonly RepoRef[], name: string): RepoRef[] => repos.filter((r) => squash(r.name) === squash(name));

/**
 * The repositories for an issue of a Sentry project: the ones Settings maps the project to (the first is the primary), else the only
 * repository of the workspace, else the one whose name is the project's (or contains it, or is contained in it, when that is
 * unambiguous). `undefined` when none of that settles it: the person is asked, in the New run dialog.
 */
export function pickFixRepos(project: string | undefined, repoMap: Readonly<Record<string, readonly string[]>>, repos: readonly RepoRef[]): FixRepos | undefined {
  const slug = squash(project ?? "");
  const key = Object.keys(repoMap).find((k) => squash(k) === slug);
  if (slug && key) {
    const found: RepoRef[] = [];
    for (const name of repoMap[key]) for (const r of byName(repos, name)) if (!found.some((f) => f.id === r.id)) found.push(r);
    if (found.length) return { primary: [found[0]], related: found.slice(1), source: "map" };
  }
  if (repos.length === 1) return { primary: [repos[0]], related: [], source: "only" };
  if (slug.length < 3) return undefined;
  const exact = repos.filter((r) => squash(r.name) === slug);
  if (exact.length === 1) return { primary: exact, related: [], source: "name" };
  const loose = repos.filter((r) => {
    const n = squash(r.name);
    return Math.min(n.length, slug.length) >= 4 && (n.includes(slug) || slug.includes(n));
  });
  return loose.length === 1 ? { primary: loose, related: [], source: "name" } : undefined;
}
