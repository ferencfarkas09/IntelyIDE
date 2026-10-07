// The page quick-list: derived statically (text scan, no code is run) from the route tables of the three repos.
// Admin and shop-pos: `src/config/pages*.js` and `src/config/pages/**.js` (route `link`, page `title`, lazy `import()`).
// Expo web has no URL routes, so its list is the screen files; every entry opens the app root.

import { t, type MessageKey } from "../../i18n";
import type { FilesIpc } from "../../ipc/files";

export type RepoKind = "admin" | "pos" | "expo" | "unknown";
export type PageKind = "login" | "list" | "other";

export const KIND_PORT: Record<Exclude<RepoKind, "unknown">, number> = { admin: 8082, pos: 8080, expo: 19006 };
/** What the user runs in their own terminal (the IDE never starts a server from the preview). */
export const KIND_START: Record<Exclude<RepoKind, "unknown">, string> = { admin: "npm start", pos: "npm run tauri:web:dev", expo: "yarn web:tauri" };
const KIND_KEY = { admin: "pv.kind.admin", pos: "pv.kind.pos", expo: "pv.kind.expo", unknown: "pv.kind.unknown" } as const satisfies Record<RepoKind, MessageKey>;
export const kindName = (kind: RepoKind): string => t(KIND_KEY[kind]);

export interface PageEntry {
  /** Route table key, e.g. `CRMLeads`, or the screen file stem. */
  key: string;
  /** Display name. */
  name: string;
  /** Path (with `:params` for dynamic routes); `/` for Expo screens. */
  link: string;
  aliases: string[];
  kind: PageKind;
  params: string[];
  /** Route table file name without extension (`admin`, `login`), or `screens`. */
  group: string;
  /** Repo-relative path of the component the route lazy-loads, extension-less (the import path resolved against the table). */
  importTarget?: string;
  /** False when the app has no URL for this page (Expo web): the entry opens the root. */
  deepLink: boolean;
  auth: boolean;
}

export function detectKind(root: readonly string[], tools: readonly string[]): RepoKind {
  if (root.includes("metro.config.js") || root.includes("app.config.js")) return "expo";
  if (tools.includes("srcWebServer.js")) return "admin";
  if (tools.includes("srcServerTauri.js")) return "pos";
  return "unknown";
}

const humanise = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();

const LOGIN_LINK = /(^|\/)(auth|login|signin|signing|sign-in|reset-password|forgot)/i;
const LOGIN_NAME = /login|sign ?in|forgot|reset ?password|change ?password/i;
const NOT_LIST = /(new|create|import|export|edit|builder|settings|status|details?|preview|success|failed|statistics|analytics|process|checkout|callback|print|view|report|map|calendar)$/i;

export function classify(link: string, name: string, group: string): PageKind {
  if (group === "login" || LOGIN_LINK.test(link) || LOGIN_NAME.test(name)) return "login";
  if (link.includes(":") || link === "*") return "other";
  const last = link.split("/").filter(Boolean).pop() ?? "";
  if (NOT_LIST.test(last) || NOT_LIST.test(name.replace(/\s+/g, ""))) return "other";
  if (/^(main|list|index|all|overview)$/i.test(last) || /s$/i.test(last) || /\blist\b/i.test(name) || / list$/i.test(name)) return "list";
  return "other";
}

const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const stripExt = (p: string) => p.replace(/\.(?:[cm]?[jt]sx?)$/, "");

/** `../../components/x` relative to the table file; null for a bare/aliased specifier. */
export function resolveImport(tablePath: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const parts = dirname(tablePath).split("/").filter(Boolean);
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return stripExt(parts.join("/"));
}

const IMPORT = /import\(\s*(?:\/\*[\s\S]*?\*\/\s*)?(['"`])([^'"`\n]+)\1/;
const CONST_IMPORT = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[\w.$]+\([^;]{0,240}?import\(\s*(?:\/\*[\s\S]*?\*\/\s*)?(['"`])([^'"`\n]+)\2/g;
const STATIC_IMPORT = /^import\s+([A-Za-z_$][\w$]*)\s+from\s+(['"`])(.+?)\2/gm;
const ENTRY = /^(\s*)([A-Za-z_$][\w$]*)\s*:\s*\{\s*(?:\/\/.*)?$/;
const CLOSE = /^\s*\}[,;]?\s*(?:\/\/.*)?$/;
const indentOf = (line: string) => line.length - line.trimStart().length;

const stringsIn = (text: string) => [...text.matchAll(/(['"`])((?:(?!\1).)*)\1/g)].map((m) => m[2]);

/** Parses one route table. Entries are `Key: {` blocks that carry a `link`; redirects, catch-alls and `link`-less blocks are left out. */
export function parsePages(source: string, tablePath: string): PageEntry[] {
  const group = tablePath.split("/").pop()!.replace(/\.[^.]+$/, "");
  const imports = new Map<string, string>();
  for (const m of source.matchAll(CONST_IMPORT)) imports.set(m[1], m[3]);
  // A page imported eagerly: `import CashRegister from '../../components/pages/cashRegister'`.
  for (const m of source.matchAll(STATIC_IMPORT)) if (!imports.has(m[1])) imports.set(m[1], m[3]);

  const lines = source.split("\n");
  type Open = { indent: number; key: string; start: number };
  const stack: Open[] = [];
  const blocks: { key: string; start: number; end: number; indent: number }[] = [];
  lines.forEach((line, i) => {
    const entry = ENTRY.exec(line);
    if (entry) {
      const indent = entry[1].length;
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      stack.push({ indent, key: entry[2], start: i });
      return;
    }
    if (CLOSE.test(line)) {
      const indent = indentOf(line);
      while (stack.length && stack[stack.length - 1].indent >= indent) {
        const o = stack.pop()!;
        blocks.push({ key: o.key, start: o.start, end: i, indent: o.indent });
      }
    }
  });
  blocks.sort((a, b) => a.start - b.start);

  const out: PageEntry[] = [];
  for (const b of blocks) {
    // Only the block's own lines: nested blocks (a `meta: {}`) are part of it, a nested route table entry is another block.
    const own = lines.slice(b.start + 1, b.end);
    const firstIndent = indentOf(own.find((l) => l.trim()) ?? "");
    const direct = own.filter((l) => l.trim() && indentOf(l) === firstIndent);
    const linkLine = direct.find((l) => /^\s*link\s*:/.test(l));
    if (!linkLine) continue;
    const link = stringsIn(linkLine)[0];
    if (!link || link === "*") continue;
    const text = own.join("\n");
    const component = /\b(?:component|render)\s*:\s*([\s\S]*)/.exec(text)?.[1] ?? "";
    const head = /^([A-Za-z_$][\w$.]*)/.exec(component)?.[1] ?? "";
    if (/^Redirect/.test(head)) continue;
    const titleLine = direct.find((l) => /^\s*title\s*:/.test(l));
    const title = titleLine ? stringsIn(titleLine)[0] : undefined;
    const aliasText = /\blinks\s*:\s*\[([\s\S]*?)\]/.exec(text)?.[1] ?? "";
    const spec = /^(?:Loadable|loadable|lazy|React\.lazy|loadWithRetry)$/.test(head) || head === "" ? IMPORT.exec(component)?.[2] : (imports.get(head) ?? IMPORT.exec(component)?.[2]);
    const name = title && /\s/.test(title) && !/[:]/.test(title) ? title : humanise(b.key);
    const params = [...link.matchAll(/:([A-Za-z_]\w*)/g)].map((m) => m[1]);
    out.push({
      key: b.key,
      name,
      link,
      aliases: stringsIn(aliasText),
      kind: classify(link, name, group),
      params,
      group,
      importTarget: spec ? (resolveImport(tablePath, spec) ?? undefined) : undefined,
      deepLink: true,
      auth: /\bauthenticationRequired\s*:\s*true\b/.test(text),
    });
  }
  return out;
}

const KIND_ORDER: Record<PageKind, number> = { login: 0, list: 1, other: 2 };

/** Login pages first, then list pages, then the rest; by path inside a kind. Dynamic routes sink to the end of their kind. */
export function sortPages(pages: readonly PageEntry[]): PageEntry[] {
  return [...pages].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || Number(a.params.length > 0) - Number(b.params.length > 0) || a.link.localeCompare(b.link) || a.key.localeCompare(b.key));
}

/** One entry per path: the first table wins (`superAdmin.js` repeats `admin.js` routes). */
export function dedupeByLink(pages: readonly PageEntry[]): PageEntry[] {
  const seen = new Set<string>();
  return pages.filter((p) => (p.deepLink ? (seen.has(p.link) ? false : (seen.add(p.link), true)) : true));
}

export function filterPages(pages: readonly PageEntry[], query: string): PageEntry[] {
  const q = query.trim().toLowerCase();
  return q ? pages.filter((p) => p.name.toLowerCase().includes(q) || p.link.toLowerCase().includes(q) || p.key.toLowerCase().includes(q)) : [...pages];
}

/** Expo web has no URL routes: each `app/screens/*Screen.js` becomes a non-deep-link entry that opens the root. */
export function expoPages(fileNames: readonly string[]): PageEntry[] {
  return fileNames
    .filter((f) => /\.(?:[jt]sx?)$/.test(f) && !/\.test\./.test(f))
    .map((f) => {
      const stem = stripExt(f);
      const name = humanise(stem.replace(/Screen$/, ""));
      const kind: PageKind = LOGIN_NAME.test(name) ? "login" : /list|home|main/i.test(name) ? "list" : "other";
      return { key: stem, name, link: "/", aliases: [], kind, params: [], group: "screens", importTarget: `app/screens/${stem}`, deepLink: false, auth: false } satisfies PageEntry;
    });
}

export interface PageMatch {
  page: PageEntry;
  /** The file is the lazy-loaded component itself (else it lives in the same folder). */
  exact: boolean;
}

/**
 * "Open the page for this file": the route whose lazy `import()` is this file (or the file's own folder import, `x/index`),
 * else the route whose component folder holds the file, deepest folder first.
 */
export function pageForFile(pages: readonly PageEntry[], file: string): PageMatch | undefined {
  const stem = stripExt(file.replace(/^\/+/, ""));
  let best: { page: PageEntry; score: number; exact: boolean } | undefined;
  for (const page of pages) {
    const target = page.importTarget;
    if (!target) continue;
    let score = 0;
    let exact = false;
    if (stem === target || stem === `${target}/index`) {
      score = 10_000 + target.length;
      exact = true;
    } else {
      const base = target.split("/").pop();
      const dirs = base === "index" ? [dirname(target)] : [target, dirname(target)];
      for (const d of dirs) if (d && d.includes("/") && stem.startsWith(`${d}/`)) score = Math.max(score, d.length);
    }
    if (!score) continue;
    // A concrete list page beats a dynamic route on a tie.
    const tie = best && score === best.score ? Number(best.page.params.length > 0) > Number(page.params.length > 0) : false;
    if (!best || score > best.score || tie) best = { page, score, exact };
  }
  return best && { page: best.page, exact: best.exact };
}

export interface Catalog {
  kind: RepoKind;
  pages: PageEntry[];
  scanned: string[];
}

type Reader = Pick<FilesIpc, "listDir" | "readFile">;

/** Reads the route tables of a repo through the files namespace (the jail and the secret guard apply as for the editor). */
export async function loadCatalog(repoId: string, files: Reader): Promise<Catalog> {
  const names = async (rel: string) => {
    try {
      return await files.listDir(repoId, rel);
    } catch {
      return [];
    }
  };
  const [root, tools] = await Promise.all([names(""), names("tools")]);
  const kind = detectKind(root.map((e) => e.name), tools.map((e) => e.name));
  if (kind === "expo") {
    const screens = await names("app/screens");
    return { kind, pages: sortPages(expoPages(screens.filter((e) => e.kind === "file").map((e) => e.name))), scanned: ["app/screens"] };
  }
  if (kind === "unknown" && !root.some((e) => e.name === "src")) return { kind, pages: [], scanned: [] };
  const tableFiles: string[] = [];
  for (const e of await names("src/config")) if (e.kind === "file" && /^pages.*\.js$/.test(e.name)) tableFiles.push(`src/config/${e.name}`);
  for (const e of await names("src/config/pages")) {
    if (e.kind === "file" && /\.js$/.test(e.name)) tableFiles.push(`src/config/pages/${e.name}`);
    else if (e.kind === "dir") for (const c of await names(`src/config/pages/${e.name}`)) if (c.kind === "file" && /\.js$/.test(c.name)) tableFiles.push(`src/config/pages/${e.name}/${c.name}`);
  }
  const all: PageEntry[] = [];
  const scanned: string[] = [];
  for (const path of tableFiles.slice(0, 40)) {
    try {
      const read = await files.readFile(repoId, path);
      if (read.text === undefined) continue;
      scanned.push(path);
      all.push(...parsePages(read.text, path));
    } catch {
      // an unreadable table is skipped; the others still list
    }
  }
  return { kind, pages: sortPages(dedupeByLink(all)), scanned };
}
