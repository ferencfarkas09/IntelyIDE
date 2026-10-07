# Golden SDK message streams

Raw messages as yielded by `query()` from `@anthropic-ai/claude-agent-sdk` 0.3.287 driving the installed `claude` 2.1.284
(`pathToClaudeCodeExecutable`), one JSON object per line, in arrival order. All runs: model `claude-haiku-4-5-20251001`, throwaway fixture
repo as cwd, `settingSources: []` + `strictMcpConfig` + inline settings unless noted, `maxTurns <= 4`, `maxBudgetUsd 0.1`.

Two sets:
- `*.jsonl` here: the Phase 0 spike recordings, kept as evidence of the wire format.
- `adapter/*.jsonl`: recorded THROUGH the real adapter by `scripts/record-golden.mjs` (cases 01, 03, 05, 07, 08; 02 is covered by the writes inside 05;
  04 needs custom subagent definitions, 06 needs deny+interrupt and 09 is the unisolated default config, none of which the adapter exposes).
- `expected/*.events.json` (and `adapter/expected/`): the normalized `AgentEvent`s `mapRaw()` produces for each file, checked by
  `sidecar/test/golden.test.ts` together with the invariants (strictly increasing gap-free seq, every tool.start ends in a tool.result, one
  turn.end per turn). Regenerate after a deliberate mapper change with `pnpm --filter @intely/sidecar test golden -- -u` and review the diff.

**Sanitized.** `scripts/sanitize-golden.mjs` (idempotent, `--check` for CI) rewrites every file: `/Users/<name>` -> `<home>`, `$TMPDIR` paths ->
`<tmp>`, plugin cache/sync paths and the per-project transcript dir -> placeholders, thinking `signature` blobs -> `<signature>`, and the local
inventory is stripped: `init.slash_commands`/`skills` emptied, `agents` reduced to the CLI's builtin names, `mcp_servers` renamed `mcp-N`,
`mcp__*` tool names dropped, non-builtin plugins renamed `plugin-N`, `commands_changed.commands` emptied, hook outputs and `informational`
text replaced by `<redacted>`. The first in-place run keeps the unsanitized originals in `.scratch/golden-original/` (git-ignored). The same
rules run as a test (`golden.test.ts`) that fails when a fixture contains `/Users/`, a macOS temp path, a token-like string (sk-, ghp_, AKIA, xox,
JWT, Bearer, long base64/hex) or any inventory name; `scripts/record-golden.mjs` refuses to write a file the scan still flags. Opaque thinking
signatures, `usage` counters and the words "token"/"key" in counters are not secrets and are not treated as such.

| file | scenario | what it shows | recorded by |
|---|---|---|---|
| `01-plain-text-partial.jsonl` | plain text reply, `includePartialMessages`, `effort:'low'`, `includeHookEvents` | `system/init`, `system/status{requesting}`, `rate_limit_event`, `stream_event` message_start / content_block_start,delta,stop / message_delta / message_stop, final `assistant`, `result/success` (with `modelUsage`). Isolated settings: zero hook events. | `s5_real.mjs isolated` |
| `02-tool-allow.jsonl` | Write tool, `canUseTool` -> `allow` with `updatedInput` | assistant `tool_use` Write, user `tool_result`, result success; the file was written with the HOST-modified content. | `s3_perm.mjs a` |
| `03-tool-deny.jsonl` | Write tool, `canUseTool` -> `deny{message}` | `tool_result` with `is_error:true` carrying the host message; model reports it; `result/success` with 1 `permission_denials` entry. | `s3_perm.mjs b` |
| `04-subagent-task.jsonl` | subagent via the **`Agent`** tool (named `Task` in older docs; handle both) with `forwardSubagentText:true` | `system/task_started`, subagent `user`/`assistant` messages carry `parent_tool_use_id` = the Agent tool_use id (forwarded text), `task_updated`, `task_notification`, then parent tool_result. | `s7_subagent.mjs` |
| `05-interrupted.jsonl` | streaming-input session: long output -> `Query.interrupt()` after 6 deltas -> follow-up turn (Write, prompted via `canUseTool`) -> `setPermissionMode('acceptEdits')` + `setModel(...)` -> Write with no prompt | `result/error_during_execution` with `terminal_reason:"aborted_streaming"` (is_error true, iterator does NOT throw in streaming-input mode), then two normal `result/success`; `system/init` is re-emitted at every turn (3x). | `s3_perm.mjs e` |
| `06-deny-interrupt.jsonl` | `canUseTool` -> `deny{interrupt:true}` (string prompt mode) | ends with `result/error_during_execution`, `terminal_reason:"aborted_tools"`; in string-prompt mode the async iterator then THROWS ("Claude Code returned an error result ...") - catch it. | `s3_perm.mjs c` |
| `07-resume.jsonl` | `resume: <sessionId>` of a session created with a pre-assigned `sessionId` | same `session_id` in init as the original; model recalled the earlier turn. | `s2_sessions.mjs` |
| `08-ask-user-question.jsonl` | `AskUserQuestion` tool through `canUseTool` (needs env `CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL=1`) | `canUseTool('AskUserQuestion', {questions:[...]})` answered with `updatedInput:{...input, answers:{[questionText]: label}}`; tool_result "Your questions have been answered: ...". | `s3_perm.mjs d` |
| `09-default-settings-hook-events.jsonl` | the SAME kind of tiny call with DEFAULT settings (user global config loaded) + `includeHookEvents` | `hook_started/hook_response` for a SessionStart hook and 2x Stop hooks (one from the user config, one from a plugin; outputs now `<redacted>`) - i.e. what leaks into agents without isolation; init listed 14 MCP servers incl. hosted connectors (now `mcp-N`). Compare with 01. | `s5_real.mjs default` |
