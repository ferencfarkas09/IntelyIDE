// Live check of the plan limits against the installed claude CLI. Skipped unless INTELY_LIVE=1. It makes no model call: the CLI starts,
// answers one control request and is closed.
//   INTELY_LIVE=1 INTELY_CLAUDE_BIN=<claude> pnpm --filter @intely/sidecar test limits-live
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { queryLimits } from '../src/limits.js';

const LIVE = process.env.INTELY_LIVE === '1';
const CLAUDE = process.env.INTELY_CLAUDE_BIN ?? (LIVE ? execFileSync('/bin/zsh', ['-ilc', 'command -v claude']).toString().trim().split('\n').pop()! : '');

describe.skipIf(!LIVE)('plan limits, live', () => {
  it('reads the 5 hour session and the 7 day week of the signed-in account', async () => {
    const r = await queryLimits({ env: { claudeBin: CLAUDE, vars: process.env as Record<string, string> }, cwd: os.tmpdir() });
    console.log('[live-limits]', JSON.stringify(r));
    expect(r).toMatchObject({ ok: true });
    if ('ok' in r && r.available) {
      for (const w of [r.fiveHour, r.sevenDay]) {
        expect(w).toBeTruthy();
        expect(w!.utilization).toBeGreaterThanOrEqual(0);
        expect(w!.utilization).toBeLessThanOrEqual(100);
        expect(Number.isFinite(Date.parse(w!.resetsAt))).toBe(true);
      }
    }
  }, 60_000);
});
