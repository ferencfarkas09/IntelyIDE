import type { SearchBatch, SearchHit, SearchIpc, SearchOptions } from "../search";
import type { MockTree } from "./files";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `*` stays inside a folder, `**` crosses folders, `?` is one character; a pattern without a slash matches the file name. */
function globToRegExp(glob: string): RegExp {
  const body = escapeRe(glob.trim())
    .replace(/\\\*\\\*\//g, "(?:.*/)?")
    .replace(/\\\*\\\*/g, ".*")
    .replace(/\\\*/g, "[^/]*")
    .replace(/\\\?/g, "[^/]");
  return new RegExp(glob.includes("/") ? `^${body}$` : `(?:^|/)${body}$`);
}

function pathFilter(glob: string | undefined): (path: string) => boolean {
  const patterns = (glob ?? "").split(",").filter((g) => g.trim()).map(globToRegExp);
  return patterns.length === 0 ? () => true : (path) => patterns.some((re) => re.test(path));
}

/** `?rg=off` in the URL imitates a machine without ripgrep (UI work only). */
const notice = new URLSearchParams(globalThis.location?.search).get("rg") === "off" ? "No ripgrep, using git grep. Faster: brew install ripgrep" : undefined;

const next = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export function createMockSearch(tree: MockTree): SearchIpc {
  const listeners = new Set<(b: SearchBatch) => void>();
  const cancelled = new Set<string>();
  const emit = (batch: SearchBatch) => listeners.forEach((cb) => cb(batch));

  function scan(repoId: string, pattern: RegExp, wanted: (path: string) => boolean): SearchHit[] {
    const hits: SearchHit[] = [];
    for (const [path, text] of tree) {
      if (path.split("/").pop()!.startsWith(".env") || !wanted(path)) continue;
      text.split("\n").forEach((line, i) => {
        for (const m of line.matchAll(pattern)) {
          if (m[0] === "") continue;
          hits.push({ repoId, path, line: i + 1, col: m.index! + 1, preview: line.trim() });
        }
      });
    }
    return hits;
  }

  return {
    async start(query, opts: SearchOptions = {}) {
      let pattern: RegExp;
      try {
        pattern = new RegExp(opts.regex ? query : escapeRe(query), opts.caseSensitive ? "g" : "gi");
      } catch (e) {
        throw { code: "invalidQuery", message: (e as Error).message };
      }
      const searchId = crypto.randomUUID();
      const wanted = pathFilter(opts.glob);
      const repoIds = opts.repoIds?.length ? opts.repoIds : ["mock"];
      void (async () => {
        for (const [i, repoId] of repoIds.entries()) {
          await next();
          const last = i === repoIds.length - 1;
          if (cancelled.has(searchId)) return emit({ searchId, hits: [], done: true });
          emit({ searchId, hits: query ? scan(repoId, pattern, wanted) : [], done: last, notice: last ? notice : undefined });
        }
      })();
      return { searchId };
    },
    async cancel(searchId) {
      cancelled.add(searchId);
    },
    onResults(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
