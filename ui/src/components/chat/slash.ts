import type { MessageKey } from "../../i18n";

/** The commands the IDE handles itself (they never reach the model). The CLI has commands of the same names; the IDE ones win. */
export const IDE_COMMANDS = ["mcp", "agents", "mode"] as const;
export type IdeCommand = (typeof IDE_COMMANDS)[number];

export const IDE_DESCRIPTION = {
  mcp: "slash.mcp.desc",
  agents: "slash.agents.desc",
  mode: "slash.mode.desc",
} as const satisfies Record<IdeCommand, MessageKey>;

/** The few CLI commands that have a hand-written line; the others show their name only. */
export const CLI_DESCRIPTION: Record<string, MessageKey> = {
  compact: "slash.cli.compact",
  context: "slash.cli.context",
  cost: "slash.cli.cost",
  review: "slash.cli.review",
  init: "slash.cli.init",
};

export interface SlashEntry {
  name: string;
  kind: "ide" | "cli";
}

const MAX_ENTRIES = 60;

export const isIdeCommand = (name: string): name is IdeCommand => (IDE_COMMANDS as readonly string[]).includes(name);

/** What follows the slash while the text is still just a command word (`/`, `/mc`); null once there is a space, a newline or no slash. */
export function slashQuery(text: string): string | null {
  const m = /^\/(\S*)$/.exec(text);
  return m ? m[1] : null;
}

/** An IDE command typed out in full (`/mcp`, `/mcp  `): sending it runs it instead. */
export function ideCommandOf(text: string): IdeCommand | null {
  const m = /^\/(\S+)\s*$/.exec(text);
  return m && isIdeCommand(m[1].toLowerCase()) ? (m[1].toLowerCase() as IdeCommand) : null;
}

/** IDE commands first, then the CLI's own, prefix matches before substring matches in each group; case-insensitive, no duplicates. */
export function slashEntries(query: string, cli: readonly string[] | undefined): SlashEntry[] {
  const q = query.toLowerCase();
  const rank = (name: string): number => {
    const n = name.toLowerCase();
    return n.startsWith(q) ? 0 : n.includes(q) ? 1 : 2;
  };
  const pick = (names: readonly string[], kind: SlashEntry["kind"]): SlashEntry[] =>
    names
      .filter((n) => rank(n) < 2)
      .map((name, i) => ({ name, kind, i }))
      .sort((a, b) => rank(a.name) - rank(b.name) || a.i - b.i)
      .map(({ name, kind: k }) => ({ name, kind: k }));
  const seen = new Set<string>(IDE_COMMANDS);
  const rest: string[] = [];
  for (const raw of cli ?? []) {
    const name = raw.replace(/^\//, "");
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    rest.push(name);
  }
  return [...pick(IDE_COMMANDS, "ide"), ...pick(rest, "cli")].slice(0, MAX_ENTRIES);
}
