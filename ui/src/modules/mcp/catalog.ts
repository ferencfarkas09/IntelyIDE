import type { MessageKey } from "../../i18n";
import type { McpTransport } from "../../ipc/mcp";
import { Brain, Compass, Database, FileSearch, FileText, Flame, GitBranch, Globe, Hammer, Layers, MousePointerClick, Search, Smartphone, Sparkles, Telescope, type LucideIcon } from "../../ui-kit";
import data from "./catalog.json";
import { blankRow, type VarRow } from "./varRows";

/*
 * Ready-made entries for well-known MCP servers (Settings > MCP servers > Add from the catalog). The list is `catalog.json`. An entry
 * is only a starting point: choosing one opens the normal editor with every field filled in, and nothing is saved, started or
 * confirmed until the person saves it there and confirms what runs, like any server added by hand. No entry carries a secret: a
 * variable that needs one is listed by NAME and marked secret, and the value is typed into the editor (it goes to the Keychain and
 * is never shown again).
 *
 * Package versions are pinned on purpose (`pkg@1.2.3` is what the confirm dialog treats as a fixed program; a tag such as `@latest`
 * would be fetched anew at every start). To update one, edit the version in its arguments. `node scripts/mcp/catalog-smoke.mjs`
 * starts every program of the list with dummy secrets and does the MCP handshake; `--latest` lists the pins that are behind.
 */

export type CatalogCategory = "code" | "browser" | "mobile" | "docs" | "data" | "search" | "design" | "thinking";

export interface CatalogVar {
  name: string;
  /** True for tokens, keys and connection strings: the editor locks the box and asks for the value. */
  secret: boolean;
  /** A plain variable that is set for the person (a switch that turns a vendor's telemetry off, say). Never for a secret. */
  value?: string;
  /** Test data only (`catalog-smoke.mjs`): a made-up value of the right shape for a server that checks its input at start. Never shown or sent. */
  smoke?: string;
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

export const CATEGORIES: readonly CatalogCategory[] = ["code", "browser", "mobile", "docs", "data", "search", "design", "thinking"];

/** The icons the data file may name. */
const ICONS = { GitBranch, Globe, MousePointerClick, FileSearch, FileText, Database, Search, Layers, Smartphone, Sparkles, Brain, Compass, Flame, Hammer, Telescope } satisfies Record<string, LucideIcon>;

/** The shape of `catalog.json`, the one list the screen, the smoke script (`scripts/mcp/catalog-smoke.mjs`) and the tests read. */
interface CatalogRecord extends Omit<CatalogEntry, "icon"> {
  icon: keyof typeof ICONS;
}

export const CATALOG: readonly CatalogEntry[] = (data as CatalogRecord[]).map((record) => ({ ...record, icon: ICONS[record.icon] }));

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

const rowOf = (v: CatalogVar): VarRow => ({ ...blankRow(), name: v.name, secret: v.secret, value: v.secret ? "" : (v.value ?? "") });

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

/** The program line of a stdio entry, or the address of an http one: what the confirm dialog will show later. */
export const entryLine = (entry: CatalogEntry): string => (entry.transport === "http" ? (entry.url ?? "") : [entry.command, ...(entry.args ?? [])].join(" "));

/** The names of the variables and headers the entry sets or asks for. */
export const entryVars = (entry: CatalogEntry): { secret: string[]; plain: string[] } => {
  const all = [...(entry.env ?? []), ...(entry.headers ?? [])];
  return { secret: all.filter((v) => v.secret).map((v) => v.name), plain: all.filter((v) => !v.secret).map((v) => v.name) };
};
