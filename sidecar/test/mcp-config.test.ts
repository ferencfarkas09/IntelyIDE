import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { moveMcpConfigToFile } from '../src/adapters/claude-sdk/mcp-config.js';
import { parseScript } from '../src/adapters/mock/script.js';
import { SCENARIOS } from '../src/adapters/mock/scenarios.js';

const CANARY = 'CANARY-MCP-7f3a-env';
const json = JSON.stringify({ mcpServers: { fs: { type: 'stdio', command: '/bin/echo', args: [], env: { TOKEN: CANARY } } } });
const base = ['--output-format', 'stream-json', '--mcp-config', json, '--strict-mcp-config', '--verbose'];
const made: string[] = [];

afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('moveMcpConfigToFile (MCP spec 5.5)', () => {
  it('puts the JSON in a 0600 file inside a 0700 directory and leaves the path in the argv, never the JSON', () => {
    const cfg = moveMcpConfigToFile(base);
    made.push(cfg.dir!);
    const i = cfg.args.indexOf('--mcp-config');
    const path = cfg.args[i + 1]!;
    expect(path).not.toContain('{');
    expect(cfg.args.join(' ')).not.toContain(CANARY);
    expect(cfg.args.filter((a) => a !== path)).toEqual(base.filter((a) => a !== json));
    expect(readFileSync(path, 'utf8')).toBe(json);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(cfg.dir!).mode & 0o777).toBe(0o700);
    expect(path.startsWith(join(tmpdir(), 'intely-mcp-'))).toBe(true);
    // the input argv is never mutated
    expect(base[3]).toBe(json);
  });

  it('cleanup removes the file and the directory and is idempotent', () => {
    const cfg = moveMcpConfigToFile(base);
    expect(existsSync(cfg.dir!)).toBe(true);
    cfg.cleanup();
    expect(existsSync(cfg.dir!)).toBe(false);
    expect(() => cfg.cleanup()).not.toThrow();
  });

  it('handles the --mcp-config=<json> spelling too', () => {
    const cfg = moveMcpConfigToFile(['--mcp-config=' + json, '--verbose']);
    made.push(cfg.dir!);
    expect(cfg.args[0]).toMatch(/^--mcp-config=\/.*intely-mcp-.*mcp\.json$/);
    expect(cfg.args.join(' ')).not.toContain(CANARY);
  });

  it('is a no-op without the flag, with an empty server set, and with a value that is already a path', () => {
    for (const args of [['--verbose'], ['--mcp-config', JSON.stringify({ mcpServers: {} })], ['--mcp-config', '/already/a/path.json'], ['--mcp-config']]) {
      const cfg = moveMcpConfigToFile(args);
      expect(cfg.args).toEqual(args);
      expect(cfg.dir).toBeUndefined();
      expect(() => cfg.cleanup()).not.toThrow();
    }
  });

  it('treats unparseable JSON text as content (it is moved, not left on the command line)', () => {
    const cfg = moveMcpConfigToFile(['--mcp-config', `{ not json ${CANARY}`]);
    made.push(cfg.dir!);
    expect(cfg.args.join(' ')).not.toContain(CANARY);
  });

  it('throws when the file cannot be written: the JSON is never left on the command line', () => {
    const ro = mkdtempSync(join(tmpdir(), 'intely-ro-'));
    made.push(ro);
    chmodSync(ro, 0o500);
    const was = process.env.TMPDIR;
    process.env.TMPDIR = ro;
    try {
      let message = '';
      try { moveMcpConfigToFile(base); } catch (e) { message = (e as Error).message; }
      expect(message).toContain('cannot write the MCP config file');
      expect(message).not.toContain(CANARY);
    } finally {
      if (was === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = was;
      chmodSync(ro, 0o700);
    }
  });
});

describe('the mcp-tools mock scenario (MCP spec 9.5)', () => {
  it('loads, and its calls are the ones the e2e flow judges with the real broker', () => {
    const steps = parseScript(SCENARIOS['mcp-tools']!).flat();
    expect(steps.filter((s) => s.op === 'call').map((s) => s.name)).toEqual([
      'mcp__fixture__echo',
      'mcp__fixture__write_note',
      'mcp__fixture__api_key_rotate',
      'mcp__other__x',
      'mcp__fixture__read_path',
      'ReadMcpResourceTool',
    ]);
    expect(steps.at(-1)!.op).toBe('end');
  });
});
