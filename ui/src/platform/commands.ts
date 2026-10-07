import { createSignal } from "solid-js";
import { t, type MessageKey } from "../i18n";
import { readStored, writeStored } from "../ui-kit/storage";
import { createRegistry, type Disposer } from "./registry";
import { registerShortcut } from "./keymap";

/** Built-in groups are registered as plain English names (the registry sorts and groups on them); the palette shows the translated label. */
const GROUP_KEY = { View: "group.view", Git: "group.git", File: "group.file", Edit: "group.edit", Agents: "group.agents", Tabs: "group.tabs", Workspace: "group.workspace" } as const satisfies Record<string, MessageKey>;
export const groupLabel = (group: string): string => (Object.hasOwn(GROUP_KEY, group) ? t(GROUP_KEY[group as keyof typeof GROUP_KEY]) : group);

export interface Command {
  /** Dotted and stable, e.g. "editor.save". */
  id: string;
  title: string;
  /** Palette group heading, e.g. "File", "Git", "View". */
  group: string;
  /** Extra words the fuzzy search matches. */
  keywords?: string[];
  /** Chord (see platform/keymap), e.g. "Mod+Shift+P". Registering the command binds it. */
  shortcut?: string;
  /** Left out of the palette's "Recent" list (the palette command itself). */
  noRecent?: boolean;
  /** Hidden from the palette and refused by `execute` while false. Reactive. */
  when?: () => boolean;
  /** An extra condition for the chord only (the palette can still run the command), e.g. "the editor area has focus". Evaluated per key press. */
  shortcutWhen?: () => boolean;
  run: (args?: unknown) => void | Promise<void>;
}

const registry = createRegistry<Command>(() => 0, "command");
const shortcutOff = new Map<string, Disposer>();

export function registerCommand(command: Command): Disposer {
  shortcutOff.get(command.id)?.();
  const off = registry.register(command);
  const { when, shortcutWhen } = command;
  const chordWhen = when && shortcutWhen ? () => when() && shortcutWhen() : (shortcutWhen ?? when);
  const offKey = command.shortcut ? registerShortcut({ id: `cmd:${command.id}`, keys: command.shortcut, command: command.id, when: chordWhen }) : undefined;
  if (offKey) shortcutOff.set(command.id, offKey);
  return () => (off(), offKey?.());
}

export const allCommands = registry.items;
/** Commands whose `when` currently holds. */
export const availableCommands = (): Command[] => registry.items().filter((c) => !c.when || c.when());
export const getCommand = registry.get;

/** Runs a command; resolves false for an unknown or currently unavailable id. A throwing command rejects. */
export async function execute(id: string, args?: unknown): Promise<boolean> {
  const command = registry.get(id);
  if (!command || (command.when && !command.when())) return false;
  await command.run(args);
  if (!command.noRecent) noteRecent(id);
  return true;
}

const RECENT_KEY = "intely.commands.recent";
const RECENT_MAX = 8;
const parseRecent = (): string[] => {
  try {
    const value: unknown = JSON.parse(readStored(RECENT_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
};
const [recent, setRecent] = createSignal<string[]>(parseRecent());

/** Most recently executed command ids, newest first. */
export const recentCommands = recent;

function noteRecent(id: string): void {
  const next = [id, ...recent().filter((x) => x !== id)].slice(0, RECENT_MAX);
  setRecent(next);
  writeStored(RECENT_KEY, JSON.stringify(next));
}

/** Subsequence match with bonuses for word starts and runs; null when `query` does not match. Higher is better. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  const t = text.toLowerCase();
  if (!q) return 0;
  let score = 0;
  let from = 0;
  let run = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, from);
    if (at < 0) return null;
    run = at === from && from > 0 ? run + 1 : 0;
    const wordStart = at === 0 || /[\s._:/-]/.test(t[at - 1]);
    score += 1 + run * 2 + (wordStart ? 3 : 0) - Math.min(at - from, 6) * 0.1;
    from = at + 1;
  }
  return score - t.length * 0.01;
}

/** Palette ordering: matches ranked by score; an empty query lists recent commands first, then by group and title. */
export function searchCommands(query: string, list: readonly Command[] = availableCommands(), recents: readonly string[] = recent()): Command[] {
  const q = query.trim();
  if (!q) {
    const rank = (c: Command) => {
      const i = recents.indexOf(c.id);
      return i < 0 ? Infinity : i;
    };
    return list.slice().sort((a, b) => rank(a) - rank(b) || groupLabel(a.group).localeCompare(groupLabel(b.group)) || a.title.localeCompare(b.title));
  }
  const scored: { c: Command; s: number }[] = [];
  for (const c of list) {
    const hay = [c.title, ...(c.keywords ?? [])];
    let best: number | null = null;
    for (const [i, h] of hay.entries()) {
      const s = fuzzyScore(q, h);
      if (s !== null && (best === null || s - i * 0.5 > best)) best = s - i * 0.5;
    }
    const g = fuzzyScore(q, `${c.group} ${c.title}`);
    if (best === null && g !== null) best = g - 2;
    if (best !== null) scored.push({ c, s: best + (recents.includes(c.id) ? 0.5 : 0) });
  }
  return scored.sort((a, b) => b.s - a.s || a.c.title.localeCompare(b.c.title)).map((x) => x.c);
}

export const resetCommands = () => {
  for (const off of shortcutOff.values()) off();
  shortcutOff.clear();
  registry.clear();
  setRecent([]);
};
