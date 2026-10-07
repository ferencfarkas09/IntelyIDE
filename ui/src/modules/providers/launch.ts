import type { LaunchInfo } from "../../ipc/providers";

/** One argument as it would be typed in a terminal: quoted only when it has to be, so the shown line is exact and copyable. */
export const shellWord = (word: string): string => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`);

/** The command line in full, as a single line. */
export const commandLine = (command: string, args: readonly string[]): string => [command, ...args].filter((w, i) => i > 0 || w !== "").map(shellWord).join(" ");

export const launchLine = (l: Pick<LaunchInfo, "command" | "args">): string => commandLine(l.command, l.args);

/** `Arguments (one per line)` text to the argument list; blank lines are dropped, nothing else is changed. */
export const argsFromLines = (text: string): string[] => text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() !== "");

export type LaunchProblem = "relative" | "empty";

/** What is wrong with a command line before it is sent to the backend (which checks again, and that is the check that counts). */
export function launchProblem(command: string): LaunchProblem | null {
  if (!command.trim()) return "empty";
  return command.trim().startsWith("/") ? null : "relative";
}
