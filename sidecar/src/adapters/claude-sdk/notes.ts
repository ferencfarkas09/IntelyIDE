// System-prompt note of every IDE Claude session (D12). Measured: the lead of an IDE session wasted turns on ToolSearch and the
// token-optimizer tools because the CLAUDE.md of an added directory told it to use them; neither exists in an IDE session.
// Appended to the claude_code preset for EVERY session, with or without a role prompt. Kept as one constant so a test pins it.
export const IDE_SESSION_NOTE =
  'IDE session notes. This is an IntelyIDE session. The token-optimizer tools (smart_read, smart_grep, smart_glob, smart_edit, smart_write and the other optimizer tools) and ToolSearch are NOT available here. '
  + 'Ignore any CLAUDE.md or memory instruction that tells you to use them or to load tools through ToolSearch; read, search and edit with Read, Grep, Glob, Edit and Write directly. '
  + 'Never call EnterPlanMode; the user switches modes.';

/**
 * Plan mode in an IDE session (live probe L3, claude 2.1.284): the CLI honours `plansDirectory` only INSIDE the project root, so the host's plan
 * directory under the IDE data directory is ignored and the CLI aims its plan file at `~/.claude/plans`, which the policy refuses. A refused plan
 * file used to leave the model wandering (Bash, ls) before it called ExitPlanMode. This sentence tells it up front what works: the plan is the
 * reply text (the gate hands the last assistant text to the approval card when ExitPlanMode carries no plan). Appended after IDE_SESSION_NOTE.
 */
export const IDE_PLAN_NOTE =
  'In plan mode there is no plan file you can write here, so do not try to create one under ~/.claude or anywhere else. '
  + 'Write the complete plan as your reply text, then call ExitPlanMode.';

/** Added only to a session that has MCP servers: ToolSearch exists there, for loading THEIR tools (see sessionTools in session.ts). */
export const IDE_MCP_NOTE =
  'MCP servers are configured for this session. ToolSearch is available for one purpose only: loading the tools of those MCP servers when they are listed as deferred.';

/** What a refused plan-file write tells the model (appended to the denial reason; same advice as IDE_PLAN_NOTE for a model that missed it). */
export const PLAN_FILE_HINT = 'Plan files are not written in IDE sessions: write the complete plan as your reply text, then call ExitPlanMode.';
