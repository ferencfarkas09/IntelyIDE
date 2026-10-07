#!/usr/bin/env node
// Beta-M0 (h): toolless Claude one-shot utility session via the Agent SDK -> structured JSON (the query-generator shape).
// Reads the prompts file written by `cargo test ... emit_prompts`, calls Haiku once per (mode,id), writes cassettes.
//   node claude-oneshot.mjs --prompts .scratch/m0-prompts.json --out .scratch/m0-cassettes [--mode p1] [--ids hu01,en01] [--max-calls 20]
// Every call is counted in <out>/calls.count and refused once the cap is reached. No tools, no MCP, no settings sources,
// empty temp cwd, session not persisted.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sdkPath = resolve(here, '../../sidecar/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
const { query } = await import(sdkPath);
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const promptsFile = arg('prompts'), outDir = arg('out');
const modeFilter = arg('mode'), idFilter = arg('ids')?.split(',');
const MAX = Number(arg('max-calls', 20));
const CLAUDE = process.env.CLAUDE_BIN || 'claude';
const MODEL = 'claude-haiku-4-5-20251001';
if (!promptsFile || !outDir) { console.error('usage: --prompts <file> --out <dir>'); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const counter = join(outDir, 'calls.count');
const used = () => (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0);

const P = JSON.parse(readFileSync(promptsFile, 'utf8'));
const env = { ...process.env };
for (const k of Object.keys(env)) if (/^(CLAUDE_|CLAUDECODE|ANTHROPIC_(MODEL|SMALL))/.test(k) && k !== 'CLAUDE_CONFIG_DIR') delete env[k];
const cwd = mkdtempSync(join(tmpdir(), 'isw-mongo-oneshot-'));

async function one(item) {
  if (used() >= MAX) throw new Error(`call cap ${MAX} reached`);
  writeFileSync(counter, String(used() + 1));
  const t0 = Date.now();
  let init = null, result = null;
  const q = query({
    prompt: item.user,
    options: {
      model: MODEL, pathToClaudeCodeExecutable: CLAUDE, cwd, env,
      systemPrompt: P.system, tools: [], settingSources: [], mcpServers: {}, strictMcpConfig: true,
      maxTurns: 3, persistSession: false, permissionMode: 'default',
      outputFormat: { type: 'json_schema', schema: P.schema },
    },
  });
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') init = { tools: m.tools, mcp: m.mcp_servers, model: m.model };
    if (m.type === 'result') result = m;
  }
  return {
    id: item.id, mode: item.mode, ms: Date.now() - t0,
    init, subtype: result?.subtype, turns: result?.num_turns, costUsd: result?.total_cost_usd, usage: result?.usage,
    structured: result?.structured_output ?? null, text: result?.result ?? null,
  };
}

let n = 0;
for (const item of P.items) {
  if (modeFilter && item.mode !== modeFilter) continue;
  if (idFilter && !idFilter.includes(item.id)) continue;
  const dir = join(outDir, item.mode); mkdirSync(dir, { recursive: true });
  const file = join(dir, `${item.id}.json`);
  if (existsSync(file) && !process.argv.includes('--force')) { console.log('cached', item.mode, item.id); continue; }
  try {
    const c = await one(item);
    writeFileSync(file, JSON.stringify(c, null, 1));
    console.log(item.mode, item.id, `${c.ms}ms`, `$${(c.costUsd ?? 0).toFixed(4)}`, `turns=${c.turns}`, `tools=${c.init?.tools?.length}`, c.structured ? 'structured' : `NO-STRUCTURED(${c.subtype})`);
  } catch (e) { console.error('FAILED', item.mode, item.id, String(e).slice(0, 200)); if (String(e).includes('cap')) break; }
  n++;
}
console.log(`done: ${n} call(s) this run, ${used()} total`);
