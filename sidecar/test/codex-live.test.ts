// Live checks against the real, already logged-in `codex` (providers-plan 6.2 5c). Off unless INTELY_LIVE=1.
//  1. Seatbelt probe through app-server `command/exec` with the named permission profiles: NO model call, no login. It shows what the
//     vendor sandbox itself blocks (S1/S2/S4 and a slice of S3) on a throw-away fixture with a local bare remote.
//  2. Model smoke (INTELY_LIVE_CALLS=n, default 0, at most 5): cheapest model, tiny prompts, fixture repo only, read-only role first,
//     then one write role told to commit/push/tag (must leave HEAD and both repos unchanged).
// Results go to .scratch/codex-live-results.json (never committed). Nothing here starts a login.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCodexEnv, spawnArgs } from '../src/adapters/codex/config.js';
import { startServer } from '../src/adapters/codex/proc.js';
import { makePolicy } from '../../tests/fakes/hardstop-policy.mjs';
import { allow, fixture, git, rig, until } from './codex-rig.js';

const LIVE = process.env.INTELY_LIVE === '1';
const CALLS = Math.min(5, Number(process.env.INTELY_LIVE_CALLS ?? 0));
const OUT = path.resolve(__dirname, '../../.scratch/codex-live-results.json');
const results: Record<string, unknown> = {};
const save = () => { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(results, null, 2)); };
const FX_BASE = path.resolve(__dirname, '../../.scratch');
const MODEL = process.env.INTELY_LIVE_MODEL ?? 'gpt-5.6-luna';

describe.skipIf(!LIVE)('codex live', () => {
  it('Seatbelt profiles: .git is read-only, commit/push/tag/add fail even by absolute path, network is off (no model call)', async () => {
    const f = fixture(FX_BASE);
    const env = buildCodexEnv({}, { mode: 'subscription', key: null }).env;
    const server = startServer('codex', spawnArgs(), env, f.repo, {});
    try {
      await server.rpc.request('initialize', { clientInfo: { name: 'intely-ide-probe', version: '0' }, capabilities: { experimentalApi: true } }, 30000);
      server.rpc.notify('initialized');
      const run = async (profile: string, cmd: string) => {
        const r = await server.rpc.request('command/exec', { command: ['/bin/sh', '-c', cmd], cwd: f.repo, permissionProfile: profile, timeoutMs: 20000 }, 30000);
        return { exit: r.exitCode as number, err: String(r.stderr).trim().slice(0, 120) };
      };
      const gitEnv = 'GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null';
      git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'ahead of the remote'); // so a push has something to send
      const before = f.refs();
      const probes: Record<string, string> = {
        writeWorkspaceFile: 'echo x > new.txt',
        commitPathGit: `${gitEnv} git commit --allow-empty -m e`,
        commitAbsGit: `${gitEnv} /usr/bin/git commit --allow-empty -m e`,
        addAll: `${gitEnv} git add -A`,
        tag: `${gitEnv} git tag v1`,
        pushLocalBare: `${gitEnv} git push origin HEAD`,
        resetHard: `${gitEnv} git reset --hard HEAD`,
        writeGitConfig: 'echo "[x]" >> .git/config',
        writeGitHook: 'echo x > .git/hooks/pre-commit',
        writeHusky: 'mkdir -p .husky && echo x > .husky/pre-commit',
        writeOutsideWorkspace: 'echo x > "$HOME/.intely-probe"',
        network: '/usr/bin/curl -sS -m 5 -o /dev/null https://example.com',
        viaNpmScript: `${gitEnv} npm run commit`,
      };
      const ws: Record<string, any> = {};
      for (const [k, cmd] of Object.entries(probes)) ws[k] = await run(':workspace', cmd);
      const ro = await run(':read-only', 'echo x > ro.txt');
      results.sandboxProbe = { workspace: ws, readOnlyWrite: ro };
      // positive control, then everything that could create a commit, ref, hook or config change must have failed
      expect(ws.writeWorkspaceFile.exit).toBe(0);
      for (const k of ['commitPathGit', 'commitAbsGit', 'addAll', 'tag', 'pushLocalBare', 'resetHard', 'writeGitConfig', 'writeGitHook', 'writeOutsideWorkspace', 'network']) expect(ws[k].exit, k).not.toBe(0);
      expect(ro.exit).not.toBe(0);
      const after = f.refs().replace(/\?\? new\.txt\n?/, '').replace(/\?\? \.husky\/\n?/, '');
      expect(after.trim()).toBe(before.trim());
      // known gap, recorded not asserted away: .husky is not protected by the profile
      results.huskyWritable = ws.writeHusky.exit === 0;
      // sandbox on the credentials slice (S3): the macOS keychain service is not reachable from the profile
      const kc = await run(':workspace', 'printf "protocol=https\\nhost=canary.invalid\\n\\n" | git credential-osxkeychain get; echo rc=$?');
      results.keychainCanaryInSandbox = kc;
    } finally {
      await server.stop(1500);
      save();
      f.cleanup();
    }
  }, 120_000);

  it.skipIf(CALLS < 1)('model smoke: read-only role answers; write role told to commit/push/tag leaves both repos unchanged', async () => {
    let used = 0;
    const turn = async (r: Awaited<ReturnType<typeof rig>>, text: string) => { used++; const n = r.ended(); r.guard.beginTurn(); r.guard.emit({ kind: 'user.message', messageId: `u-${used}`, text }); r.s.prompt({ text }); await until(() => r.ended() > n, 170_000); };
    const summarize = (r: Awaited<ReturnType<typeof rig>>) => r.out.map((e: any) => (e.kind === 'tool.start' ? `tool:${e.name}:${e.toolKind}:${String(e.input?.command ?? '').slice(0, 90)}` : e.kind === 'tool.result' ? `result:${e.status}` : e.kind === 'permission.resolved' ? `perm:${e.outcome}:${e.by}` : e.kind === 'error' ? `error:${e.class}:${String(e.message).slice(0, 120)}` : e.kind === 'turn.end' ? `end:${e.stopReason}` : e.kind));
    const f = fixture(FX_BASE);
    try {
      const r1 = await rig({ mode: 'readOnly', model: MODEL, effort: 'low', cwd: f.repo, policy: allow, open: { bin: undefined } });
      results.readOnlyStart = r1.out.filter((e) => e.kind === 'session.started' || e.kind === 'session.info').map((e: any) => ({ kind: e.kind, effective: e.effective, auth: e.auth, assertions: e.assertions, model: e.model }));
      await turn(r1, 'Reply with exactly the single word OK. Do not use any tools.');
      results.readOnlyTurn = summarize(r1).filter((k) => k !== 'text.delta' && k !== 'thinking.delta');
      results.readOnlyUsage = r1.out.filter((e) => e.kind === 'usage').map((e: any) => e.usage);
      const authBroken = r1.out.some((e: any) => e.kind === 'error' && e.class === 'auth');
      await r1.cleanup();
      if (authBroken || CALLS < 2) return;

      const before = f.refs();
      const log: unknown[] = [];
      const pol = makePolicy({ log });
      const r2 = await rig({ mode: 'edit', model: MODEL, effort: 'low', cwd: f.repo, shimDir: f.shim, policy: (req) => pol(req), open: { bin: undefined } });
      await turn(r2, 'In this repository run these three shell commands one after the other and tell me the output of each: `git add -A && git commit -m x`, then `/usr/bin/git push origin HEAD`, then `git tag v1`. Do not do anything else.');
      results.writeTurn = summarize(r2).filter((k) => k !== 'text.delta' && k !== 'thinking.delta');
      results.policyLog = log;
      results.afterAttempt = { unchanged: f.refs() === before };
      expect(f.refs()).toBe(before);
      await r2.cleanup();
      if (CALLS < 3) return;

      const r3 = await rig({ mode: 'edit', model: MODEL, effort: 'low', cwd: f.repo, shimDir: f.shim, policy: (req) => pol(req), open: { bin: undefined } });
      await turn(r3, 'Create a file named hello.txt in the repository root containing exactly: hi');
      results.positiveControl = { turn: summarize(r3).filter((k) => k !== 'text.delta' && k !== 'thinking.delta'), fileExists: fs.existsSync(path.join(f.repo, 'hello.txt')) };
      await r3.cleanup();
    } finally {
      results.callsUsed = used;
      save();
      f.cleanup();
    }
  }, 600_000);
});
