// "Fix with agent" / "Explain this error": an error from the terminal, a dev server, a script, a pre-commit check, the
// component preview (or any module that has one, such as a React Native red screen) becomes the prompt of a new run.
// The text is cleaned of terminal colours, cut to its last 8 KB and masked for secrets before it reaches the prompt, and
// the New Run dialog only opens prefilled: nothing runs until the person presses Start run.
import { vibeIpc } from "../ipc/vibe";
import { requestNewRun } from "./newRun";

/** Where the error was seen; names the source in the prompt. */
export type ErrorKind = "terminal" | "devServer" | "script" | "check" | "preview" | "redbox" | "other";
export type ErrorIntent = "fix" | "explain";

export interface ErrorPromptInput {
  kind: ErrorKind;
  /** The error output (log lines, a stack). Cut to its last `MAX_LOG_BYTES` and masked. */
  text: string;
  /** The repository the run should work in; missing leaves the dialog's default scope. */
  repoId?: string;
  /** One fact per line that helps the agent: the script, the command, the exit code, the file. Masked too. */
  extra?: string;
  intent?: ErrorIntent;
}

/** The most of an error log that goes into a prompt. A longer log keeps its end, where the error usually is. */
export const MAX_LOG_BYTES = 8 * 1024;

const SOURCE: Record<ErrorKind, string> = {
  terminal: "my terminal",
  devServer: "my dev server",
  script: "a script I ran",
  check: "a pre-commit check",
  preview: "the component preview",
  redbox: "the React Native error screen",
  other: "my app",
};

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Terminal colours and control characters out, carriage-return redraws folded, line endings normalised. */
export function cleanLog(text: string): string {
  return text
    .replace(ANSI, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => (line.includes("\r") ? line.slice(line.lastIndexOf("\r") + 1) : line))
    .join("\n")
    .replace(CONTROL, "")
    .replace(/[ \t]+$/gm, "");
}

/** The end of `text` that fits in `maxBytes` of UTF-8, starting at a line when one starts close enough. */
export function tailBytes(text: string, maxBytes = MAX_LOG_BYTES): { text: string; cut: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return { text, cut: false };
  let start = bytes.length - maxBytes;
  // never start inside a UTF-8 sequence
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  let tail = new TextDecoder().decode(bytes.subarray(start));
  const nl = tail.indexOf("\n");
  if (nl >= 0 && nl < 400) tail = tail.slice(nl + 1);
  return { text: tail, cut: true };
}

const ERRORISH = /\b(error|errors|failed|failure|fatal|exception|traceback|panicked|cannot|could not|not found|undefined is not|unhandled|ERR!|E\d{3,})\b|✖|✗|×/i;

/**
 * The last error block of a terminal or log: from a little before the last line that looks like an error to the end of
 * what follows it. The whole text when nothing looks like an error.
 */
export function lastErrorBlock(lines: readonly string[], before = 20, after = 60): string {
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ERRORISH.test(lines[i])) {
      at = i;
      break;
    }
  }
  if (at < 0) return lines.join("\n").trim();
  // walk up over the block of error lines that ends here (stack frames, "at ..." lines)
  let first = at;
  for (let i = at - 1; i >= Math.max(0, at - 200); i--) {
    if (ERRORISH.test(lines[i])) first = i;
    else if (!lines[i].trim()) break;
  }
  return lines.slice(Math.max(0, first - before), Math.min(lines.length, at + 1 + after)).join("\n").trim();
}

/** A code fence longer than any run of backticks inside the text, so the log cannot close it. */
function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(longest + 1);
}

/** The prompt text, masked. Pure apart from the masker; `mask` is swappable for tests. */
export async function buildErrorPrompt(input: ErrorPromptInput, mask: (text: string) => Promise<string> = (t) => vibeIpc().maskText(t)): Promise<string> {
  const intent = input.intent ?? "fix";
  const { text: tail, cut } = tailBytes(cleanLog(input.text).trim());
  const [log, extra] = await Promise.all([mask(tail), input.extra?.trim() ? mask(cleanLog(input.extra).trim()) : Promise.resolve("")]);
  const f = fence(log);
  const head =
    intent === "fix"
      ? `Fix this error from ${SOURCE[input.kind]}.`
      : `Explain this error from ${SOURCE[input.kind]} in plain language: what it means, the most likely cause in this project, and what I could do about it. Do not change any file.`;
  const parts = [head];
  if (extra) parts.push(extra);
  parts.push(`${cut ? "The end of the output (shortened):" : "The output:"}\n${f}text\n${log || "(empty)"}\n${f}`);
  if (intent === "fix") {
    parts.push(
      [
        "How to work:",
        "1. Find the root cause: open the file and line the output points to first, then its callers. Be sure of the cause before you change anything.",
        "2. Make the smallest change that removes the cause. Do not refactor or reformat unrelated code.",
        "3. If the project has a test, lint or build command for this area, run it to show the error is gone.",
        "4. Do not commit or push. End with two or three plain sentences: what was wrong and what you changed.",
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}

/** Opens the New Run dialog with the prompt; resolves false when the dialog could not be opened. */
export async function sendErrorToAgent(input: ErrorPromptInput): Promise<boolean> {
  const prompt = await buildErrorPrompt(input);
  return requestNewRun({ prompt, repoIds: input.repoId ? [input.repoId] : undefined });
}
