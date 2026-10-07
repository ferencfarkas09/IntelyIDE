#!/usr/bin/env node
// Markdown step summary of a gate run ((design notes: release-ci-spec) 5.3, rule 5.2.14). Everything it prints that can
// come from a pull request (gate names, step names, notes, file names) is escaped: Markdown syntax is neutralised,
// line breaks become spaces and a leading `::` or `##[` (a workflow command) is broken.
//
//   node scripts/ci/summary.mjs --gate-summary <summary.json> [--title <text>] [--line <text>]... [--append <file> | --stdout]
//
// Without --append it writes to $GITHUB_STEP_SUMMARY when set, else to stdout. Exit 0, or 1 on unreadable input.
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const LINE_BREAKS = new RegExp("[\\r\\n\\u2028\\u2029]+", "g");

/** Break a leading workflow command and flatten line breaks. */
export function neutralise(text) {
  return String(text)
    .replace(LINE_BREAKS, " ")
    .replace(/^(\s*)::/, "$1: :")
    .replace(/^(\s*)##\[/, "$1# #[");
}

/** Escape Markdown (inline) in addition to neutralise(). */
export function escapeMd(text) {
  return neutralise(text)
    .replace(/[\\`*_{}[\]()<>#+!|~$&]/g, "\\$&")
    .replace(/^(\s*)([-.:=])/, "$1\\$2")
    .replace(/^(\s*)(\d+)\./, "$1$2\\.");
}

const ICON = { PASS: "pass", FAIL: "FAIL", SKIP: "skip", "KNOWN-RED": "known-red" };

export function renderGateSummary(summary, title = "") {
  const out = [];
  out.push(`### ${escapeMd(title || `Gates (${summary.profile ?? "?"})`)}`);
  out.push("");
  out.push("| Gate | Name | Result | Seconds |");
  out.push("|---|---|---|---|");
  for (const g of summary.gates ?? []) {
    out.push(`| ${escapeMd(g.id)} | ${escapeMd(g.name)} | ${escapeMd(ICON[g.status] ?? g.status)} | ${Number(g.seconds) || 0} |`);
  }
  const c = summary.counts ?? {};
  out.push("");
  out.push(`${c.pass ?? 0} pass, ${c.fail ?? 0} fail, ${c.knownRed ?? 0} known-red, ${c.skip ?? 0} skipped. ${summary.ok ? "OK." : "NOT OK."}`);
  const notes = [];
  for (const g of summary.gates ?? []) {
    for (const n of g.notes ?? []) notes.push(`- ${escapeMd(g.id)}: ${escapeMd(n)}`);
    for (const s of g.steps ?? []) {
      if (s.status === "FAIL") notes.push(`- ${escapeMd(g.id)} failed step: ${escapeMd(s.name)}`);
      else if (s.status === "SKIP") notes.push(`- ${escapeMd(g.id)} skipped: ${escapeMd(s.name)} (${escapeMd(s.note ?? "")})`);
    }
  }
  if (notes.length) out.push("", ...notes);
  if ((summary.remainingReds ?? []).length) {
    out.push("", "Known-red entries in force:");
    for (const r of summary.remainingReds) out.push(`- ${escapeMd(r.gate)} ${escapeMd(r.step)} (owner: ${escapeMd(r.owner)})`);
  }
  if ((summary.stale ?? []).length) {
    out.push("", "Stale known-red entries (delete them):");
    for (const s of summary.stale) out.push(`- ${escapeMd(s.gate)} ${escapeMd(s.step)}`);
  }
  return out.join("\n") + "\n";
}

export function main(argv, env = process.env, stdout = process.stdout) {
  const sums = [];
  const lines = [];
  let title = "";
  let append = null;
  let toStdout = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    try {
      if (a === "--gate-summary") sums.push(val());
      else if (a === "--title") title = val();
      else if (a === "--line") lines.push(val());
      else if (a === "--append") append = val();
      else if (a === "--stdout") toStdout = true;
      else throw new Error(`unknown argument ${neutralise(a)}`);
    } catch (e) {
      console.error(`summary: ${e.message}`);
      return 1;
    }
  }
  let text = "";
  for (const f of sums) {
    let json;
    try {
      json = JSON.parse(readFileSync(f, "utf8"));
    } catch (e) {
      console.error(`summary: cannot read ${neutralise(f)}: ${neutralise(e.message)}`);
      return 1;
    }
    text += renderGateSummary(json, title) + "\n";
  }
  for (const l of lines) text += `- ${escapeMd(l)}\n`;
  const target = toStdout ? null : (append ?? env.GITHUB_STEP_SUMMARY ?? null);
  if (target) appendFileSync(target, text);
  else stdout.write(text);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
