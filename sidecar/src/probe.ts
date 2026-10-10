// `node index.js --probe`: one JSON line about this machine for the host's Setup / health check of a server. Never throws, starts no session.
import os from 'node:os';
import { redact } from './redact.js';
import { loadSdk, sdkReport, SdkError } from './sdk.js';

export type ProbeSdk = { ok: true; version: string } | { ok: false; code: string; detail: string };
export interface Probe { sidecar: string; node: string; platform: string; arch: string; home: string; sdk: ProbeSdk }

export const PROBE_SDK_TIMEOUT_MS = 8000;

/** `load` and `timeoutMs` are for tests. The SDK check is the loader's own (location, pin and hash verification), nothing else. */
export async function probe(version: string, o: { load?: () => Promise<unknown>; report?: () => { version: string } | null; timeoutMs?: number } = {}): Promise<Probe> {
  const load = o.load ?? (() => loadSdk());
  const report = o.report ?? sdkReport;
  let sdk: ProbeSdk;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([load(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('the SDK check timed out')), o.timeoutMs ?? PROBE_SDK_TIMEOUT_MS); })]);
    sdk = { ok: true, version: report()?.version ?? 'unknown' };
  } catch (e) {
    const code = e instanceof SdkError ? e.code : 'sdk_broken';
    sdk = { ok: false, code, detail: redact(String((e as Error)?.message ?? e)).replace(`${code}: `, '').slice(0, 500) };
  } finally { clearTimeout(timer); }
  let home = '';
  try { home = os.homedir(); } catch { /* no passwd entry */ }
  return { sidecar: version, node: process.version, platform: process.platform, arch: process.arch, home, sdk };
}
