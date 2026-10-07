// Inline settings overlay (layer 1 of providers-plan 3.3): deny rules that must beat a permissive settings.local.json.
// Together with settingSources [] and strictMcpConfig this isolates the session from the user's global Claude config.
import type { SessionEnv } from '../../types.js';

export const DENY_RULES = [
  'Bash(git commit:*)', 'Bash(git push:*)', 'Bash(git add -A:*)', 'Bash(git add --all:*)', 'Bash(git add .)', 'Bash(git add . *)',
  'Bash(git * commit*)', 'Bash(git * push*)', 'Bash(git * add -A*)', 'Bash(git * add .)',
  'Bash(env git*)', 'Bash(*/git commit*)', 'Bash(*/git push*)', 'Bash(gh pr merge*)', 'Bash(gh pr create*)',
  'Bash(*INTELY_HUMAN_TOKEN*)',
  'Edit(**/.husky/**)', 'Write(**/.husky/**)', 'Edit(**/.git/**)', 'Write(**/.git/**)', 'Edit(**/.claude/**)', 'Write(**/.claude/**)',
];

// Claude's own Remote Control would be a second approval channel inside the `claude` process (it bypasses the broker, the audit
// log, device capabilities and the kill switch of IntelyIDE Remote), so every run is launched with it disabled (remote-plan 1,
// providers-plan 5.10). Only the Mac-side opt-in toggle may pass `allowRemoteControl`; nothing does yet, and the deny-rule ablation
// of the enforcement suite never touches this.
// `addDirs` is passed HERE and never as the CLI flag `--add-dir`: measured against claude 2.1.284, a session started with
// `--setting-sources= --strict-mcp-config --add-dir <repo with a .claude folder>` loads the user's plugins (and their PreToolUse
// hooks, which can hold gigabytes), while the same directories in `permissions.additionalDirectories` of the inline settings do not.
// `planDir` is where the CLI keeps its plan notes: without it plan mode aims at the user's real ~/.claude/plans (measured by the modes spike),
// which no IDE session may touch. MEASURED (probe L3, claude 2.1.284): the CLI honours it only INSIDE the project root (a relative value, or an
// absolute one under the cwd); an absolute path outside the cwd, one inside an added directory, and a relative `../x` are all ignored and the
// default is used. The policy refuses that default, and the gate tells the model to put the plan in its reply text (notes.ts).
export function settingsOverlay(env: SessionEnv, denyRules = true, allowRemoteControl = false, addDirs: readonly string[] = [], planDir?: string): Record<string, unknown> {
  const deny = denyRules ? [...DENY_RULES] : [];
  if (denyRules && env.shimDir) deny.push(`Edit(${env.shimDir}/**)`, `Write(${env.shimDir}/**)`);
  return {
    hooks: {},
    enabledPlugins: {},
    permissions: { deny, ...(addDirs.length ? { additionalDirectories: [...addDirs] } : {}) },
    ...(allowRemoteControl ? {} : { disableRemoteControl: true }),
    ...(planDir ? { plansDirectory: planDir } : {}),
  };
}
