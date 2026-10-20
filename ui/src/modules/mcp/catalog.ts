import type { MessageKey } from "../../i18n";
import type { McpTransport } from "../../ipc/mcp";
import { Database, FileSearch, FileText, GitBranch, Globe, Layers, MousePointerClick, Search, type LucideIcon } from "../../ui-kit";
import { blankRow, type VarRow } from "./varRows";

/*
 * Ready-made entries for well-known MCP servers (Settings > MCP servers > Add from the catalog). An entry is only a starting point:
 * choosing one opens the normal editor with every field filled in, and nothing is saved, started or confirmed until the person saves
 * it there and confirms what runs, like any server added by hand. No entry carries a secret: a variable that needs one is listed by
 * NAME and marked secret, and the value is typed into the editor (it goes to the Keychain and is never shown again).
 *
 * Package versions are pinned on purpose (`pkg@1.2.3` is what the confirm dialog treats as a fixed program; a tag such as `@latest`
 * would be fetched anew at every start). To update one, edit the version in its arguments. Every launch line below was checked
 * against the package's own README and the registry when the entry was added.
 */

export type CatalogCategory = "code" | "browser" | "docs" | "data" | "search" | "design";

export interface CatalogVar {
  name: string;
  /** Always true for tokens, keys and connection strings: the editor locks the box and asks for the value. */
  secret: boolean;
}

export interface CatalogEntry {
  /** Also the suggested server name (the prefix of the tool names agents see): lowercase, digits and hyphens. */
  id: string;
  /** The product's name as its makers write it. */
  title: string;
  icon: LucideIcon;
  category: CatalogCategory;
  transport: McpTransport;
  command?: string;
  args?: readonly string[];
  url?: string;
  env?: readonly CatalogVar[];
  headers?: readonly CatalogVar[];
  /** The arguments or the URL already restrict the server to reading. */
  readOnly?: boolean;
  /** One sentence: what the agent can do with it. */
  summary: MessageKey;
  /** What to prepare before saving: where to get the token, what has to be installed or running. Shown at the top of the editor. */
  setup: MessageKey;
}

export const CATEGORIES: readonly CatalogCategory[] = ["code", "browser", "docs", "data", "search", "design"];

export const CATALOG: readonly CatalogEntry[] = [
  {
    id: "github",
    title: "GitHub",
    icon: GitBranch,
    category: "code",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/readonly",
    headers: [{ name: "Authorization", secret: true }],
    readOnly: true,
    summary: "mcp.catalog.github.summary",
    setup: "mcp.catalog.github.setup",
  },
  {
    id: "chrome-devtools",
    title: "Chrome DevTools",
    icon: Globe,
    category: "browser",
    transport: "stdio",
    command: "npx",
    args: ["-y", "chrome-devtools-mcp@1.11.0", "--no-usage-statistics", "--no-performance-crux"],
    summary: "mcp.catalog.chromeDevtools.summary",
    setup: "mcp.catalog.chromeDevtools.setup",
  },
  {
    id: "playwright",
    title: "Playwright",
    icon: MousePointerClick,
    category: "browser",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@0.0.83"],
    summary: "mcp.catalog.playwright.summary",
    setup: "mcp.catalog.playwright.setup",
  },
  {
    id: "context7",
    title: "Context7",
    icon: FileSearch,
    category: "docs",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp@4.4.4"],
    readOnly: true,
    summary: "mcp.catalog.context7.summary",
    setup: "mcp.catalog.context7.setup",
  },
  {
    id: "notion",
    title: "Notion",
    icon: FileText,
    category: "docs",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@notionhq/notion-mcp-server@2.5.2"],
    env: [{ name: "NOTION_TOKEN", secret: true }],
    summary: "mcp.catalog.notion.summary",
    setup: "mcp.catalog.notion.setup",
  },
  {
    id: "mongodb",
    title: "MongoDB",
    icon: Database,
    category: "data",
    transport: "stdio",
    command: "npx",
    args: ["-y", "mongodb-mcp-server@3.1.0", "--readOnly"],
    env: [{ name: "MDB_MCP_CONNECTION_STRING", secret: true }],
    readOnly: true,
    summary: "mcp.catalog.mongodb.summary",
    setup: "mcp.catalog.mongodb.setup",
  },
  {
    id: "brave-search",
    title: "Brave Search",
    icon: Search,
    category: "search",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@brave/brave-search-mcp-server@2.1.4", "--transport", "stdio"],
    env: [{ name: "BRAVE_API_KEY", secret: true }],
    readOnly: true,
    summary: "mcp.catalog.braveSearch.summary",
    setup: "mcp.catalog.braveSearch.setup",
  },
  {
    id: "figma",
    title: "Figma",
    icon: Layers,
    category: "design",
    transport: "http",
    url: "http://127.0.0.1:3845/mcp",
    summary: "mcp.catalog.figma.summary",
    setup: "mcp.catalog.figma.setup",
  },
];

/** What the editor is opened with: the entry's fields, a free server name, and the text to show above the form. */
export interface ServerTemplate {
  title: string;
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  url: string;
  env: VarRow[];
  headers: VarRow[];
  setup: MessageKey;
}

/** The entry's id if it is free, else `id-2`, `id-3`... (names are unique, case-insensitively). */
export function freeName(id: string, taken: readonly string[]): string {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  if (!used.has(id)) return id;
  for (let n = 2; ; n++) {
    const candidate = `${id}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

const rowOf = (v: CatalogVar): VarRow => ({ ...blankRow(), name: v.name, secret: v.secret });

export function templateOf(entry: CatalogEntry, taken: readonly string[]): ServerTemplate {
  return {
    title: entry.title,
    name: freeName(entry.id, taken),
    transport: entry.transport,
    command: entry.command ?? "",
    args: [...(entry.args ?? [])],
    url: entry.url ?? "",
    env: (entry.env ?? []).map(rowOf),
    headers: (entry.headers ?? []).map(rowOf),
    setup: entry.setup,
  };
}

/** Whether the server starts through `npx`: Node.js has to be installed. */
export const needsNode = (entry: CatalogEntry): boolean => entry.command === "npx";
/** Whether the person has to bring a token, a key or a connection string. */
export const needsSecret = (entry: CatalogEntry): boolean => [...(entry.env ?? []), ...(entry.headers ?? [])].some((v) => v.secret);

export function matchesCatalog(entry: CatalogEntry, query: string, summary: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || entry.title.toLowerCase().includes(q) || entry.id.includes(q) || summary.toLowerCase().includes(q);
}
