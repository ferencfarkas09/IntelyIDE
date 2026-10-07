#!/usr/bin/env node
// The single required status check of `main` ((design notes: release-ci-spec) 5.3, X8). The `ci-ok` job runs with
// `if: always()` and `needs: [...]`, and gives this script the needs context:
//
//   NEEDS_JSON='${{ toJSON(needs) }}' node scripts/ci/ci-ok.mjs [--expect a,b,c] [--skippable x,y]
//
// Every expected job must be present and `success`; the pull-request-only jobs may be `skipped`. `failure`,
// `cancelled`, a skipped job that is not pull-request-only, an unknown job and a missing job all fail the check, so
// a skipped job can never pass it by accident. Exit 0 all good, 1 anything else. Job names are printed escaped.
import { pathToFileURL } from "node:url";

export const EXPECTED = ["lint-workflows", "js", "gates", "rust", "deny", "dco", "dependency-review", "release-verify"];
export const SKIPPABLE = ["dco", "dependency-review"];

const clean = (s) =>
  String(s)
    .replace(/[\r\n]+/g, " ")
    .replace(/^(\s*)::/, "$1: :")
    .replace(/^(\s*)##\[/, "$1# #[")
    .slice(0, 120);

/** Returns { ok, lines } for a needs context object. */
export function evaluate(needs, expected = EXPECTED, skippable = SKIPPABLE) {
  const lines = [];
  let ok = true;
  if (needs === null || typeof needs !== "object" || Array.isArray(needs)) {
    return { ok: false, lines: ["FAIL needs context is not an object"] };
  }
  for (const job of expected) {
    const n = needs[job];
    const result = n && typeof n === "object" ? n.result : undefined;
    if (result === "success") lines.push(`ok    ${job}: success`);
    else if (result === "skipped" && skippable.includes(job)) lines.push(`ok    ${job}: skipped (pull-request-only job)`);
    else {
      ok = false;
      lines.push(`FAIL  ${clean(job)}: ${result === undefined ? "missing from the needs context" : clean(result)}`);
    }
  }
  for (const job of Object.keys(needs)) {
    if (!expected.includes(job)) {
      ok = false;
      lines.push(`FAIL  ${clean(job)}: unknown job (not in the expected list)`);
    }
  }
  return { ok, lines };
}

export function main(argv, env = process.env, out = console) {
  let expected = EXPECTED;
  let skippable = SKIPPABLE;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--expect" && argv[i + 1]) expected = argv[++i].split(",").filter(Boolean);
    else if (argv[i] === "--skippable" && argv[i + 1]) skippable = argv[++i].split(",").filter(Boolean);
    else {
      out.error(`ci-ok: unknown argument ${clean(argv[i])}`);
      return 1;
    }
  }
  if (!env.NEEDS_JSON) {
    out.error("ci-ok: NEEDS_JSON is not set");
    return 1;
  }
  let needs;
  try {
    needs = JSON.parse(env.NEEDS_JSON);
  } catch {
    out.error("ci-ok: NEEDS_JSON is not valid JSON");
    return 1;
  }
  const { ok, lines } = evaluate(needs, expected, skippable);
  for (const l of lines) (l.startsWith("FAIL") ? out.error : out.log)(l);
  out.log(ok ? "ci-ok: all required jobs passed" : "ci-ok: NOT OK");
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
