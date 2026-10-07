#!/usr/bin/env node
// Status and report helper of scripts/release/gate.sh ((design notes: release-ci-spec) 4.2, 4.3). Reads the steps files the
// gate scripts write, the known-red registry, and prints; it never runs a gate and never writes outside --out.
//
//   report.mjs validate  --registry <file>                    shape check of the registry (exit 0 / 1)
//   report.mjs classify  --registry <f> --gate G07 --steps <f> --rc <n> --honour 0|1
//        prints tab separated lines: status <S> | failstep <name> | known <step> <owner> <decision> <reason>
//        | skip <reason> | note <text>
//   report.mjs finalize  --registry <f> --run-dir <dir> --profile <p> --honour 0|1 [--out summary.json]
//        reads <run-dir>/results.tsv, prints the table, the stale and remaining-red sections, writes summary.json;
//        exit 0 when no gate failed and no registry entry is stale, 1 otherwise
//
// Steps file lines (tab separated): `STEP <name> <PASS|FAIL|SKIP> <seconds> <note>` and `NOTE <text>`.
// Registry (scripts/release/known-red.json): a JSON array of
//   { "gate": "G07", "step": "licenses:check --release", "reason": "...", "decision": "...", "owner": "...", "since": "YYYY-MM-DD" }
// `step` may be "*" for every failing step of the gate. The registry can only shrink: an entry whose step passes in
// a run that honours the registry is reported as stale and fails the run.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const GATE_IDS = Array.from({ length: 21 }, (_, i) => `G${String(i + 1).padStart(2, "0")}`);
const REQUIRED = ["gate", "step", "reason", "decision", "owner", "since"];

export function readSteps(file) {
  const steps = [];
  const notes = [];
  if (!file || !existsSync(file)) return { steps, notes };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    const f = line.split("\t");
    if (f[0] === "STEP") steps.push({ name: f[1] ?? "", status: f[2] ?? "FAIL", seconds: Number(f[3] ?? 0) || 0, note: f.slice(4).join("\t") });
    else if (f[0] === "NOTE") notes.push(f.slice(1).join("\t"));
  }
  return { steps, notes };
}

export function loadRegistry(file) {
  const problems = [];
  // No file is an empty registry (a fixture tree, or a checkout before RC3's file exists); gate.sh --check-registry insists on the file.
  if (!file || !existsSync(file)) return { entries: [], problems: [] };
  let json;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { entries: [], problems: [`registry is not valid JSON: ${e.message}`] };
  }
  if (!Array.isArray(json)) return { entries: [], problems: ["registry must be a JSON array"] };
  const seen = new Set();
  json.forEach((e, i) => {
    const where = `entry ${i + 1}`;
    if (e === null || typeof e !== "object" || Array.isArray(e)) {
      problems.push(`${where}: not an object`);
      return;
    }
    for (const k of REQUIRED) {
      if (typeof e[k] !== "string" || e[k].trim() === "") problems.push(`${where}: "${k}" must be a non-empty string`);
    }
    if (typeof e.gate === "string" && !GATE_IDS.includes(e.gate)) problems.push(`${where}: unknown gate "${e.gate}"`);
    if (typeof e.since === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(e.since)) problems.push(`${where}: "since" must be YYYY-MM-DD`);
    const key = `${e.gate}\u0000${e.step}`;
    if (seen.has(key)) problems.push(`${where}: duplicate entry for ${e.gate} / ${e.step}`);
    seen.add(key);
  });
  return { entries: json.filter((e) => e && typeof e === "object"), problems };
}

const matches = (entry, gate, step) => entry.gate === gate && (entry.step === "*" || entry.step === step);

/** Decide the status of one gate from its steps. */
export function classify({ entries, gate, steps, rc, honour }) {
  const out = { status: "PASS", failSteps: [], known: [], skipReason: "", notes: [] };
  let list = steps.slice();
  if (list.length === 0 && rc !== 10 && rc !== 0) list = [{ name: "gate script", status: "FAIL", note: `exit ${rc}, no step recorded` }];
  else if (list.length === 0 && rc === 0) list = [];
  if (rc !== 0 && rc !== 1 && rc !== 10 && !list.some((s) => s.status === "FAIL")) list.push({ name: "gate script", status: "FAIL", note: `exit ${rc}` });
  const failing = list.filter((s) => s.status === "FAIL");
  const passing = list.filter((s) => s.status === "PASS");
  if (failing.length === 0) {
    if (passing.length === 0 && list.length > 0) {
      out.status = "SKIP";
      out.skipReason = list.map((s) => `${s.name}: ${s.note}`).join("; ");
    }
    return out;
  }
  out.failSteps = failing.map((s) => s.name);
  if (honour) {
    for (const s of failing) {
      const e = entries.find((x) => matches(x, gate, s.name));
      if (e) out.known.push({ step: s.name, owner: e.owner, decision: e.decision, reason: e.reason, since: e.since });
    }
    out.status = out.known.length === failing.length ? "KNOWN-RED" : "FAIL";
  } else {
    out.status = "FAIL";
  }
  return out;
}

/** Registry entries whose failing step passes now (only for gates that ran, only when the registry is honoured). */
export function staleEntries(entries, gates) {
  const stale = [];
  for (const e of entries) {
    const g = gates.find((x) => x.id === e.gate);
    if (!g || g.status === "SKIP") continue;
    if (e.step === "*") {
      if (g.status === "PASS") stale.push(e);
      continue;
    }
    const s = g.steps.find((x) => x.name === e.step);
    if (s && s.status === "PASS") stale.push(e);
  }
  return stale;
}

// Output that may contain text from a pull request (step notes, log lines) never starts a workflow command.
export const neutralise = (s) =>
  String(s)
    .replace(/\r/g, "")
    .replace(/\n/g, " ")
    .replace(/^(\s*)::/, "$1: :")
    .replace(/^(\s*)##\[/, "$1# #[");

const pad = (s, n) => (s.length >= n ? s : s + " ".repeat(n - s.length));

export function finalize({ registry, runDir, profile, honour, out }) {
  const { entries, problems } = loadRegistry(registry);
  const lines = [];
  const rows = existsSync(join(runDir, "results.tsv")) ? readFileSync(join(runDir, "results.tsv"), "utf8").split("\n").filter(Boolean) : [];
  const gates = rows.map((l) => {
    const [id, name, status, seconds, log] = l.split("\t");
    const { steps, notes } = readSteps(join(runDir, `${id}.steps`));
    return { id, name, status, seconds: Number(seconds) || 0, log: log ?? "", steps, notes };
  });
  const stale = honour ? staleEntries(entries, gates) : [];
  const remaining = [];
  for (const g of gates) {
    if (g.status !== "KNOWN-RED") continue;
    for (const s of g.steps.filter((x) => x.status === "FAIL")) {
      const e = entries.find((x) => matches(x, g.id, s.name));
      if (e) remaining.push({ gate: g.id, step: s.name, owner: e.owner, decision: e.decision, reason: e.reason, since: e.since });
    }
  }
  const failed = gates.filter((g) => g.status === "FAIL");
  // A tag-grade run must not contain a skipped gate or a skipped step: a SKIP is a check that did not happen.
  const strictProfile = profile === "release" || profile === "ci-release";
  const skipped = strictProfile
    ? gates.flatMap((g) => (g.status === "SKIP" ? [{ gate: g.id, step: "(whole gate)" }] : g.steps.filter((x) => x.status === "SKIP").map((x) => ({ gate: g.id, step: x.name }))))
    : [];
  const ok = failed.length === 0 && stale.length === 0 && skipped.length === 0 && (problems.length === 0 || !honour);
  const count = (st) => gates.filter((g) => g.status === st).length;

  lines.push("");
  lines.push(`Gate summary (${profile})`);
  lines.push(`${pad("ID", 5)}${pad("GATE", 20)}${pad("RESULT", 11)}TIME`);
  for (const g of gates) lines.push(`${pad(g.id, 5)}${pad(g.name, 20)}${pad(g.status, 11)}${g.seconds}s`);
  lines.push(`PASS ${count("PASS")}  FAIL ${count("FAIL")}  KNOWN-RED ${count("KNOWN-RED")}  SKIP ${count("SKIP")}  (${gates.length} gates)`);
  if (skipped.length) {
    lines.push("");
    for (const k of skipped) lines.push(`skipped in a ${profile} run: ${k.gate} / ${k.step} (a release profile does not accept a SKIP)`);
  }
  if (stale.length) {
    lines.push("");
    for (const e of stale) {
      lines.push(`stale known-red entry ${e.gate} / ${e.step}: the step passes now, delete the entry from scripts/release/known-red.json`);
    }
  }
  if (honour && problems.length) {
    lines.push("");
    for (const p of problems) lines.push(`known-red registry problem: ${p}`);
  }
  if (profile === "release-rehearsal") {
    lines.push("");
    lines.push("Remaining reds (what a green --release is still waiting for)");
    if (remaining.length === 0) lines.push("  none");
    else {
      lines.push(`  ${pad("GATE", 6)}${pad("STEP", 34)}${pad("OWNER", 30)}DECISION`);
      for (const r of remaining) lines.push(`  ${pad(r.gate, 6)}${pad(r.step, 34)}${pad(r.owner, 30)}${r.decision}`);
    }
  }
  if (out) {
    const summary = {
      schema: 1,
      profile,
      ok,
      honourRegistry: !!honour,
      counts: { pass: count("PASS"), fail: count("FAIL"), knownRed: count("KNOWN-RED"), skip: count("SKIP") },
      gates: gates.map((g) => ({ id: g.id, name: g.name, status: g.status, seconds: g.seconds, log: g.log, notes: g.notes, steps: g.steps })),
      remainingReds: remaining,
      stale: stale.map((e) => ({ gate: e.gate, step: e.step })),
      skippedInStrict: skipped,
    };
    writeFileSync(out, JSON.stringify(summary, null, 2) + "\n");
  }
  return { ok, text: lines.map(neutralise).join("\n") + "\n" };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
    o[a.slice(2)] = argv[++i];
  }
  return o;
}

export function main(argv) {
  const cmd = argv[0];
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    console.error(`report: ${e.message}`);
    return 2;
  }
  if (cmd === "validate") {
    const { problems } = loadRegistry(o.registry);
    for (const p of problems) console.error(`FAIL ${p}`);
    if (problems.length === 0) console.log(`known-red registry OK (${loadRegistry(o.registry).entries.length} entries)`);
    return problems.length ? 1 : 0;
  }
  if (cmd === "classify") {
    const { entries } = loadRegistry(o.registry);
    const { steps, notes } = readSteps(o.steps);
    const r = classify({ entries, gate: o.gate, steps, rc: Number(o.rc), honour: o.honour === "1" });
    const t = (...f) => console.log(f.map((x) => String(x).replace(/[\t\n]/g, " ")).join("\t"));
    t("status", r.status);
    for (const s of r.failSteps) t("failstep", s);
    for (const k of r.known) t("known", k.step, k.owner, k.decision, k.reason);
    if (r.skipReason) t("skip", r.skipReason);
    for (const n of notes) t("note", n);
    return 0;
  }
  if (cmd === "finalize") {
    const r = finalize({ registry: o.registry, runDir: o["run-dir"], profile: o.profile, honour: o.honour === "1", out: o.out });
    process.stdout.write(r.text);
    return r.ok ? 0 : 1;
  }
  console.error("usage: report.mjs validate|classify|finalize ...");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
