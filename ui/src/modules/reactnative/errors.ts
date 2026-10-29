// Recognises the typical React Native failures in Metro output and device logs. Pure: lines in, cards out. The lines were
// masked by the backend (the runner's masker for Metro, the devices crate for the device streams) before they got here.
import type { ErrorCard, ErrorKind, Source } from "./types";

export const MAX_CARDS = 12;
const MAX_SNIPPET = 300;
const MAX_CONTEXT = 6;
const MAX_LINES = 4000;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** The line without colour codes and control characters, trimmed, at most `max` chars. */
export function plain(line: string, max = MAX_SNIPPET): string {
  return line.replace(ANSI, "").replace(CONTROL, "").trim().slice(0, max);
}

interface Rule {
  kind: ErrorKind;
  test: RegExp;
}

// Order matters: the first rule that matches a line wins, so the specific ones come before the general ones.
const RULES: readonly Rule[] = [
  { kind: "unresolvedModule", test: /unable to resolve module|unable to resolve "[^"]+" from|module not found: error: can't resolve/i },
  { kind: "noBundleUrl", test: /no bundle url present|could not connect to development server|unable to load script/i },
  { kind: "portInUse", test: /\bport \d{4,5} is (already )?(being )?(used|in use)|eaddrinuse|address already in use|is running this app in another window|something is already running on port/i },
  { kind: "podsOutOfDate", test: /the sandbox is not in sync with the podfile\.lock|pod install.*(required|needed|to update)|podfile\.lock.*(out of date|not in sync)|no podspec found for|cocoapods could not find compatible versions/i },
  { kind: "gradleFailed", test: /execution failed for task ':|what went wrong:|build failed with an exception|> task :[^ ]+ failed|\bFAILURE: Build failed|could not resolve all (files|dependencies)|sdk location not found/i },
  { kind: "xcodeFailed", test: /\*\* build failed \*\*|xcodebuild.*(failed|error)|error: .*\.(m|mm|swift|h):\d+|the following build commands failed|\berror: no such module|code signing is required|provisioning profile/i },
  { kind: "nativeCrash", test: /fatal exception|fatal signal \d+|terminating app due to uncaught exception|\bsigsegv\b|\bsigabrt\b|libc\s*:\s*fatal signal|has crashed|rctfatal|unhandled js exception/i },
  { kind: "undefinedFunction", test: /undefined is not a function|undefined is not an object|cannot read propert(y|ies)\b.{0,100}\b(undefined|null)\b|is not a function\b|null is not an object/i },
  { kind: "redbox", test: /invariant violation|redbox/i },
  { kind: "jsException", test: /\b(Type|Reference|Syntax|Range)Error: |unhandled promise rejection|possible unhandled promise/i },
];

/** The kind a single line stands for, or undefined. */
export function classifyError(line: string): ErrorKind | undefined {
  const text = plain(line, 600);
  if (!text) return undefined;
  return RULES.find((r) => r.test.test(text))?.kind;
}

/** A short stable hash of kind + the line without numbers (timestamps, pids, addresses), for deduplication. */
function idOf(kind: ErrorKind, snippet: string): string {
  const norm = snippet.replace(/0x[0-9a-f]+|\d+/gi, "#").toLowerCase();
  let h = 5381;
  for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) | 0;
  return `${kind}:${(h >>> 0).toString(36)}`;
}

/**
 * Cards for the error lines in `lines`, newest last, deduplicated (a repeated error raises `count`), at most [`MAX_CARDS`].
 * `existing` cards are kept and updated, so feeding only the new lines of a stream is enough.
 */
export function collectErrors(lines: readonly string[], source: Source, existing: readonly ErrorCard[] = []): ErrorCard[] {
  const cards = existing.map((c) => ({ ...c }));
  const from = Math.max(0, lines.length - MAX_LINES);
  for (let i = from; i < lines.length; i++) {
    const kind = classifyError(lines[i]);
    if (!kind) continue;
    const snippet = plain(lines[i]);
    const id = idOf(kind, snippet);
    const hit = cards.find((c) => c.id === id);
    if (hit) {
      hit.count += 1;
      continue;
    }
    const context = lines
      .slice(i + 1, i + 1 + MAX_CONTEXT)
      .map((l) => plain(l))
      .filter((l) => l && classifyError(l) !== kind);
    cards.push({ id, kind, source, snippet, context, count: 1 });
  }
  return cards.slice(-MAX_CARDS);
}
