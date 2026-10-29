// The browser stand-in of `ipc/vibe.ts`, and the local secret masker that also guards the real app when the backend
// cannot be asked. The masker covers the common shapes (keyed values, known token prefixes, bearer tokens, JWTs,
// credentials in URLs, long hex strings); the app's own masker (`crates/runner/src/mask.rs`) covers more.
import type { NotesPlan, SetupCheck, VibeIpc } from "../vibe";

const MASK = "***";
const KEYS = "token|secret|password|passwd|pwd|api[_-]?key|auth|credential|private[_-]?key|access[_-]?key";
const PREFIXES = ["github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "glpat-", "xox[abposr]-", "sk-", "sk_live_", "rk_live_", "AIza", "npm_", "AKIA"];

const RULES: [RegExp, string][] = [
  // KEY=value, KEY: value, "key": "value", --token value (the value up to the next space or quote)
  [new RegExp(`((?:[A-Za-z0-9_.-]*(?:${KEYS})[A-Za-z0-9_.-]*)["']?\\s*[:=]\\s*["']?)([^\\s"'$][^\\s"',;]*)`, "gi"), `$1${MASK}`],
  [new RegExp(`(--?(?:[A-Za-z0-9-]*(?:${KEYS})[A-Za-z0-9-]*)\\s+)([^\\s-][^\\s]*)`, "gi"), `$1${MASK}`],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${MASK}`],
  [/\b(Authorization|Cookie|Set-Cookie)(\s*:\s*)[^\n]+/gi, `$1$2${MASK}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${MASK}@`],
  [new RegExp(`\\b(?:${PREFIXES.join("|")})[A-Za-z0-9_-]{12,}`, "g"), MASK],
  [/\b[a-f0-9]{40,}\b/gi, MASK],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
];

/** Masks the secret shapes listed above. Idempotent; text without a secret comes back unchanged. */
export function maskLocally(text: string): string {
  return RULES.reduce((s, [re, to]) => s.replace(re, to), text);
}

const CHECKS: SetupCheck[] = [
  { id: "node", status: "ok", version: "24.4.0", path: "/opt/homebrew/bin/node", reason: null, optional: false },
  { id: "git", status: "ok", version: "2.50.1", path: "/usr/bin/git", reason: null, optional: false },
  { id: "gh", status: "missing", version: null, path: null, reason: null, optional: true },
  { id: "xcode", status: "ok", version: null, path: "/Applications/Xcode.app/Contents/Developer", reason: null, optional: false },
  { id: "cocoapods", status: "ok", version: "1.16.2", path: "/opt/homebrew/bin/pod", reason: null, optional: true },
  { id: "android", status: "warn", version: null, path: null, reason: "notConfigured", optional: true },
  { id: "watchman", status: "missing", version: null, path: null, reason: null, optional: true },
];

const NOTE = "# Project notes\n\n- Use pnpm, never npm.\n- Run `pnpm test` before you finish.\n- Components live in src/components, one per file.\n";
const MINE = "Answer in short sentences. Explain what you changed in plain language.\n";

export function createMockVibe(): VibeIpc {
  return {
    maskText: async (text) => maskLocally(text),
    setupChecks: async () => structuredClone(CHECKS),
    projectNotes: async (repoIds): Promise<NotesPlan> => {
      const files: NotesPlan["files"] = [{ scope: "user", dirIndex: null, rel: "CLAUDE.md", path: "~/.claude/CLAUDE.md", size: MINE.length, text: MINE, length: MINE.length, shortened: false }];
      if (repoIds.length) files.push({ scope: "project", dirIndex: 0, rel: "CLAUDE.md", path: `/Users/me/code/${repoIds[0]}/CLAUDE.md`, size: NOTE.length, text: NOTE, length: NOTE.length, shortened: false });
      return { files, total: files.reduce((n, f) => n + f.length, 0), fileMax: 32 * 1024, totalMax: 96 * 1024, userMax: 32 * 1024, leftOut: [] };
    },
  };
}
