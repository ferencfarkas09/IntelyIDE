// Drift canary (providers-plan 6.2 5c, 7): regenerates the app-server JSON schema of the INSTALLED codex (no login, no network, no
// model call) and checks that every method, notification and enum value the adapter relies on still exists. Skipped when codex is not installed.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REQ } from '../src/adapters/codex/wire.js';
import { tmp } from './codex-rig.js';

const have = (() => { try { execFileSync('codex', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

describe.skipIf(!have)('codex app-server schema still has what the adapter uses', () => {
  const dir = have ? tmp('schema') : '';
  if (have) execFileSync('codex', ['app-server', 'generate-json-schema', '--experimental', '--out', dir], { stdio: 'ignore', timeout: 60_000 });
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const methods = (f: string): string[] => (read(f).oneOf ?? []).map((o: any) => o.properties?.method?.enum?.[0] ?? o.properties?.method?.const).filter(Boolean);
  const find = (f: string, def: string): any => { const j = read(f); return j.definitions?.[def] ?? (j.title === def ? j : undefined); };
  const props = (f: string, def: string) => Object.keys(find(f, def)?.properties ?? {});

  it('client requests', () => {
    const m = methods('ClientRequest.json');
    for (const x of ['initialize', 'thread/start', 'thread/resume', 'turn/start', 'turn/interrupt', 'model/list', 'account/read', 'command/exec', 'permissionProfile/list']) expect(m, x).toContain(x);
  }, 60_000);

  it('server requests the gate handles', () => {
    const m = methods('ServerRequest.json');
    for (const x of Object.values(REQ)) expect(m, x).toContain(x);
  });

  it('notifications the mapper reads', () => {
    const m = methods('ServerNotification.json');
    for (const x of ['turn/started', 'turn/completed', 'item/started', 'item/completed', 'item/agentMessage/delta', 'item/reasoning/summaryTextDelta', 'item/commandExecution/outputDelta', 'thread/tokenUsage/updated', 'turn/plan/updated', 'error', 'account/rateLimits/updated', 'model/rerouted']) expect(m, x).toContain(x);
  });

  it('parameters and decisions', () => {
    expect(props('v2/ThreadStartParams.json', 'ThreadStartParams')).toEqual(expect.arrayContaining(['cwd', 'model', 'approvalPolicy', 'permissions', 'ephemeral', 'developerInstructions']));
    expect(props('v2/TurnStartParams.json', 'TurnStartParams')).toEqual(expect.arrayContaining(['threadId', 'input', 'cwd', 'model', 'effort', 'summary', 'approvalPolicy', 'permissions']));
    expect(props('v2/ThreadStartResponse.json', 'ThreadStartResponse')).toEqual(expect.arrayContaining(['thread', 'sandbox', 'approvalPolicy', 'activePermissionProfile']));
    expect(props('CommandExecutionRequestApprovalParams.json', 'CommandExecutionRequestApprovalParams')).toEqual(expect.arrayContaining(['itemId', 'command', 'availableDecisions', 'networkApprovalContext', 'additionalPermissions']));
    expect(props('FileChangeRequestApprovalParams.json', 'FileChangeRequestApprovalParams')).toEqual(expect.arrayContaining(['itemId', 'grantRoot']));
    const decisions = JSON.stringify(find('CommandExecutionRequestApprovalResponse.json', 'CommandExecutionApprovalDecision'));
    for (const d of ['accept', 'decline', 'cancel']) expect(decisions).toContain(`"${d}"`);
  });
});
