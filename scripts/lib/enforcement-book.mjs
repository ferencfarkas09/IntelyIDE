// Turns the output of scripts/enforcement-suite.mjs into a run of the host's enforcement book (`enforcement.json`,
// crates/agent_core/src/policy/enforcement.rs) and merges it into an existing file. The tier is NOT computed here: the host
// computes it from the recorded suites and layers, per (adapter, auth mode, role mode, CLI version).
//
// What a run records: S1 and S2 from the live Haiku attempts, the hook and deny-rule layers from their ablation attempts.
// S0 (the ~30 bypass strings against the real policy) is run by `cargo test -p intely-agent-core --test bypass`, not by this
// script, so it is recorded only when the caller says it was green (`s0: "pass"`); otherwise it stays notRun and the tier stays weak.
// The shim is never recorded as a layer ((design notes: providers-plan) 3.1: an absolute path bypasses it).
import fs from 'node:fs';
import path from 'node:path';

const SUITES = ['t0', 's0', 's1', 's2', 's3', 's4'];

/** `claude 2.1.284 (Claude Code)` -> `2.1.284`. */
export const cliVersionOf = (text) => /\d+\.\d+(?:\.\d+)?/.exec(String(text ?? ''))?.[0] ?? '';

/** One book run from a suite result (the JSON enforcement-suite.mjs writes). */
export function bookRun(result, { s0 = 'notRun', at = Date.now(), adapter = 'claude-sdk', authMode = 'subscription', roleMode = 'edit' } = {}) {
  const verdict = (name) => (result.suites?.[name] === 'pass' || result.suites?.[name] === 'fail' ? result.suites[name] : 'notRun');
  const suites = Object.fromEntries(SUITES.map((s) => [s, 'notRun']));
  suites.s0 = s0;
  suites.s1 = verdict('S1');
  suites.s2 = verdict('S2');
  const layersProven = ['denyRules', 'hook'].filter((l) => result.layers?.[l] === 'proven');
  return { key: { adapter, authMode, roleMode, cliVersion: cliVersionOf(result.claudeVersion) }, suites, layersProven, at };
}

const sameSlot = (a, b) => a.adapter === b.adapter && a.authMode === b.authMode && a.roleMode === b.roleMode;

/** The book with `run` in its slot; runs of the same adapter for another CLI version are dropped (stale evidence, as `observe_cli_version`). */
export function mergeBook(book, run) {
  const runs = (book?.runs ?? []).filter((r) => r.key.adapter !== run.key.adapter || r.key.cliVersion === run.key.cliVersion).filter((r) => !sameSlot(r.key, run.key));
  return { runs: [...runs, run] };
}

/** Writes `<dir>/enforcement.json` atomically (mode 0600), creating the directory. Returns the file. */
export function recordBook(dir, run) {
  const file = path.join(dir, 'enforcement.json');
  let book = { runs: [] };
  try { book = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(mergeBook(book, run), null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}
