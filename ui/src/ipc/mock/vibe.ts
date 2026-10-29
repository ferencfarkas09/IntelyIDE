// The browser stand-in of `ipc/vibe.ts`. Masking uses the interface's port of the app's masker (`../vibeMask.ts`).
import type { NotesPlan, SetupCheck, VibeIpc } from "../vibe";
import { maskLocally } from "../vibeMask";

export { maskLocally };

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
