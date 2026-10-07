// S-12 (permission-modes spec 2.2, 8.3): every tool the PINNED SDK can offer is classified exactly once in `sdkToolCoverage` (constants.json,
// written by the policy builder's `SDK_TOOL_COVERAGE`). Bypass allows "any other tool" by design (D6), which is only safe if the set of tools
// the SDK declares is closed: a bump of sidecar/sdk-pin that adds a publish or upload tool fails HERE, with the interface name, instead of
// silently opening a channel.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { intentFor } from '../src/adapters/claude-sdk/intent.js';

const SDK_TOOLS_DTS = path.resolve(__dirname, '../node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts');
const CONSTANTS = path.resolve(__dirname, '../../packages/protocol/fixtures/constants.json');

type Entry = { input: string; tool: string; kind: string };
const declared = [...readFileSync(SDK_TOOLS_DTS, 'utf8').matchAll(/^export interface (\w+Input)\b/gm)].map((m) => m[1]!);
const coverage = (JSON.parse(readFileSync(CONSTANTS, 'utf8')) as { sdkToolCoverage?: Entry[] }).sdkToolCoverage ?? [];
const KINDS = ['exec', 'write', 'read', 'net', 'spawn', 'mcp', 'planmode', 'otherknown', 'otherstatechange'];
const kindOf = (e: Entry) => e.kind.toLowerCase();

const HOW = 'Add it to SDK_TOOL_COVERAGE in crates/agent_core/src/policy/mod.rs with exactly one ToolKind (docs/permission-modes-spec.md 2.2): '
  + 'Exec, Write, Read, Net, Spawn, Mcp, PlanMode, OtherKnown (only for a tool that touches the session\'s own UI or task state, or only reads) or '
  + 'OtherStateChange (anything that publishes, uploads, schedules, or acts outside the machine); then run pnpm protocol:gen.';

describe('SDK tool coverage (the pinned sdk-tools.d.ts against constants.json sdkToolCoverage)', () => {
  it('the pinned SDK declares its tool inputs (the parser still finds them)', () => {
    expect(declared.length).toBeGreaterThanOrEqual(40);
    expect(declared).toEqual(expect.arrayContaining(['BashInput', 'FileEditInput', 'AgentInput', 'ExitPlanModeInput', 'ArtifactInput']));
  });

  it('the constant is not empty (the policy builder has delivered SDK_TOOL_COVERAGE)', () => {
    expect(coverage.length, 'constants.json sdkToolCoverage is empty: SDK_TOOL_COVERAGE in crates/agent_core/src/policy/mod.rs is still the Types-step stub. ' + HOW).toBeGreaterThan(0);
  });

  it('every interface the SDK declares is classified', () => {
    const have = new Set(coverage.map((e) => e.input));
    const missing = declared.filter((n) => !have.has(n));
    expect(missing, `the pinned SDK declares ${missing.join(', ')} but sdkToolCoverage does not list ${missing.length === 1 ? 'it' : 'them'}. ${HOW}`).toEqual([]);
  });

  it('the constant lists nothing the pinned file no longer declares', () => {
    const have = new Set(declared);
    const stale = coverage.filter((e) => !have.has(e.input)).map((e) => e.input);
    expect(stale, `sdkToolCoverage lists ${stale.join(', ')}, which sdk-tools.d.ts does not declare any more: remove ${stale.length === 1 ? 'it' : 'them'} (or the pin moved back).`).toEqual([]);
  });

  it('each interface appears once, with one known kind and a tool name', () => {
    const seen = new Set<string>();
    for (const e of coverage) {
      expect(seen.has(e.input), `${e.input} is listed twice`).toBe(false);
      seen.add(e.input);
      expect(KINDS, `${e.input}: unknown ToolKind "${e.kind}"`).toContain(kindOf(e));
      expect(e.tool, `${e.input} has no tool name`).toBeTruthy();
    }
  });

  it('the sidecar classifies the tool name the hook sees like the kind says (so Rust and the sidecar agree)', () => {
    const sample: Record<string, Record<string, unknown>> = {
      exec: { command: 'echo' }, write: { file_path: '/x' }, read: { file_path: '/x' }, net: { url: 'https://example.invalid' }, spawn: { subagent_type: 'x' },
    };
    const wantClass: Record<string, string> = { exec: 'exec', write: 'write', read: 'read', net: 'net', spawn: 'other', planmode: 'other', otherknown: 'other', otherstatechange: 'other' };
    for (const e of coverage) {
      const k = kindOf(e);
      if (!wantClass[k]) continue; // Mcp: the resource tools take the MCP order (MCP spec 5.4), classified by the policy builder's intent.ts hunk
      expect(intentFor(e.tool, sample[k] ?? {}).class, `${e.input} (${e.tool}) is kind ${e.kind}`).toBe(wantClass[k]);
    }
  });
});
