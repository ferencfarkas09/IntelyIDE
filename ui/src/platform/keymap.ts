import { createSignal } from "solid-js";
import { createRegistry, type Disposer } from "./registry";

/**
 * Global shortcut registry. A chord is written "Mod+Shift+P": `Mod` is Cmd on macOS and Ctrl elsewhere, `Cmd` and `Ctrl`
 * are literal. The key is matched by the character it produces (so Hungarian QWERTZ keeps working), falling back to the
 * physical key for digits and punctuation that need dead keys.
 *
 * Hungarian layouts produce characters with bare Option/AltGr (`Option+V` = "@", `Option+X` = "#", ...), so a chord whose
 * only modifier is Alt (optionally with Shift) is refused. Use Cmd/Ctrl plus Alt instead.
 */
export interface Chord {
  key: string;
  cmd: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export interface Shortcut {
  /** Defaults to the chord; unique per registration. */
  id: string;
  keys: string;
  /** Command id to execute (see platform/commands). Either this or `run`. */
  command?: string;
  run?: () => void;
  /** Evaluated per key press; false lets the event through untouched. */
  when?: () => boolean;
}

export const isMac = (): boolean => typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

const ALIASES: Record<string, string> = {
  esc: "escape",
  return: "enter",
  space: " ",
  spacebar: " ",
  comma: ",",
  period: ".",
  plus: "+",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  option: "alt",
  opt: "alt",
  command: "cmd",
  meta: "cmd",
};

export function parseChord(text: string, mac: boolean = isMac()): Chord {
  const chord: Chord = { key: "", cmd: false, ctrl: false, alt: false, shift: false };
  const parts = text.split(/\+(?!$)/).map((p) => p.trim());
  for (const raw of parts) {
    const part = ALIASES[raw.toLowerCase()] ?? raw.toLowerCase();
    if (part === "mod") mac ? (chord.cmd = true) : (chord.ctrl = true);
    else if (part === "cmd") chord.cmd = true;
    else if (part === "ctrl") chord.ctrl = true;
    else if (part === "alt") chord.alt = true;
    else if (part === "shift") chord.shift = true;
    else if (chord.key) throw new Error(`Chord "${text}" has two keys`);
    else chord.key = part;
  }
  if (!chord.key) throw new Error(`Chord "${text}" has no key`);
  return chord;
}

/** Why a chord is not allowed, or null. */
export function chordProblem(chord: Chord): string | null {
  if (chord.alt && !chord.cmd && !chord.ctrl) return "bare Option/Alt chords type characters on the Hungarian layout; combine with Cmd or Ctrl";
  if (!chord.cmd && !chord.ctrl && !chord.alt && chord.key.length === 1) return "a bare character key would steal typing";
  return null;
}

const PHYSICAL: Record<string, string> = { Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Backquote: "`" };

function eventKey(e: KeyboardEvent): string {
  const key = e.key.toLowerCase();
  if (key.length > 1) return key;
  const physical = e.code.startsWith("Digit") ? e.code.slice(5) : e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : PHYSICAL[e.code];
  // With Option held macOS reports the typed character ("å"), and Shift turns "1" into "!": the physical key is the chord's key.
  if (physical && (e.altKey || ((e.metaKey || e.ctrlKey) && /^[0-9]$/.test(physical)))) return physical;
  return /^[\x21-\x7e]$/.test(key) ? key : (physical ?? key);
}

export function matches(chord: Chord, e: KeyboardEvent): boolean {
  return e.metaKey === chord.cmd && e.ctrlKey === chord.ctrl && e.altKey === chord.alt && e.shiftKey === chord.shift && eventKey(e) === chord.key;
}

const SYMBOLS: Record<string, string> = { cmd: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧", enter: "↵", escape: "Esc", tab: "⇥", arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→", backspace: "⌫", " ": "Space" };

/** Key chips for the Kbd component: ["⌘", "⇧", "P"], in the macOS order Ctrl, Alt, Shift, Cmd. */
export function formatChord(text: string, mac: boolean = isMac()): string[] {
  const c = parseChord(text, mac);
  const out: string[] = [];
  if (c.ctrl) out.push(SYMBOLS.ctrl);
  if (c.alt) out.push(SYMBOLS.alt);
  if (c.shift) out.push(SYMBOLS.shift);
  if (c.cmd) out.push(SYMBOLS.cmd);
  out.push(SYMBOLS[c.key] ?? c.key.toUpperCase());
  return out;
}

const registry = createRegistry<Shortcut & { chord: Chord }>(() => 0, "shortcut");
const [conflicts, setConflicts] = createSignal<string[]>([]);

/** Throws for a refused chord (see `chordProblem`); a duplicate chord is allowed but reported by `shortcutConflicts()`. */
export function registerShortcut(shortcut: Omit<Shortcut, "id"> & { id?: string }): Disposer {
  if (!shortcut.command && !shortcut.run) throw new Error(`Shortcut ${shortcut.keys} needs a command or a run function`);
  const chord = parseChord(shortcut.keys);
  const problem = chordProblem(chord);
  if (problem) throw new Error(`Shortcut ${shortcut.keys}: ${problem}`);
  const id = shortcut.id ?? shortcut.keys;
  const clash = registry.items().find((s) => s.id !== id && sameChord(s.chord, chord));
  if (clash) setConflicts((c) => [...c, `${shortcut.keys}: ${clash.id} vs ${id}`]);
  return registry.register({ ...shortcut, id, chord });
}

const sameChord = (a: Chord, b: Chord) => a.key === b.key && a.cmd === b.cmd && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift;

export const shortcuts = registry.items;
export const shortcutConflicts = conflicts;
/** The first registered chord of a command, for palette chips and tooltips. */
export const shortcutFor = (commandId: string): string | undefined => registry.items().find((s) => s.command === commandId)?.keys;

type Runner = (commandId: string) => unknown;

/** Dispatches a key event to the first matching shortcut; true when it was handled. Exported for tests. */
export function dispatchKey(e: KeyboardEvent, execute: Runner): boolean {
  if (e.defaultPrevented || e.isComposing) return false;
  for (const s of registry.items()) {
    if (!matches(s.chord, e) || (s.when && !s.when())) continue;
    e.preventDefault();
    if (s.command) void execute(s.command);
    else s.run?.();
    return true;
  }
  return false;
}

/** Installs the single global listener (capture phase, so a focused editor cannot swallow app shortcuts). */
export function installKeymap(execute: Runner, target: Pick<Window, "addEventListener" | "removeEventListener"> = window): Disposer {
  const handler = (e: Event) => void dispatchKey(e as KeyboardEvent, execute);
  target.addEventListener("keydown", handler, true);
  return () => target.removeEventListener("keydown", handler, true);
}

export const resetKeymap = () => (registry.clear(), setConflicts([]));
