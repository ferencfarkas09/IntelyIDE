#!/usr/bin/env node
// One toolless Claude call for the MongoDB Studio query generator (the `ClaudeOneShotPort` transport of crates/mongo).
// stdin: {system, schema, user, model, cap, counter}; stdout: one JSON line {structured, ms, costUsd, usage, turns, tools} or {error}.
// No tools, no MCP, no settings sources, empty temp cwd, session not persisted. Every real call is counted in the counter
// file and refused once `cap` is reached (the test budget is small on purpose).
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let cwd;
try {
  const p = JSON.parse(readFileSync(0, 'utf8'));
  const used = existsSync(p.counter) ? Number(readFileSync(p.counter, 'utf8')) : 0;
  if (used >= p.cap) { out({ error: `call cap ${p.cap} reached` }); process.exit(0); }
  writeFileSync(p.counter, String(used + 1));
  const { query } = await import(resolve(here, '../../sidecar/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE_|CLAUDECODE|ANTHROPIC_(MODEL|SMALL))/.test(k) && k !== 'CLAUDE_CONFIG_DIR') delete env[k];
  cwd = mkdtempSync(join(tmpdir(), 'isw-mongo-oneshot-'));
  const t0 = Date.now();
  let init = null, result = null;
  const q = query({
    prompt: p.user,
    options: {
      model: p.model, pathToClaudeCodeExecutable: process.env.CLAUDE_BIN || 'claude', cwd, env,
      systemPrompt: p.system, tools: [], settingSources: [], mcpServers: {}, strictMcpConfig: true,
      maxTurns: 6, persistSession: false, permissionMode: 'default',
      outputFormat: { type: 'json_schema', schema: p.schema },
    },
  });
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') init = { tools: m.tools, model: m.model };
    if (m.type === 'result') result = m;
  }
  out({ structured: result?.structured_output ?? null, ms: Date.now() - t0, costUsd: result?.total_cost_usd ?? null, usage: result?.usage ?? null, turns: result?.num_turns ?? null, tools: init?.tools?.length ?? null, model: init?.model ?? null, subtype: result?.subtype ?? null });
} catch (e) {
  out({ error: String(e).slice(0, 300) });
} finally {
  if (cwd) try { rmSync(cwd, { recursive: true, force: true }); } catch {}
}
process.exit(0);
