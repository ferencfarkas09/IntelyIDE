// The run summary in plain words: the backend's digest (facts only, already masked) turned into short sentences from
// i18n templates in the UI language. No model is involved; "Explain in plain words" only prefills a New Run prompt
// with these facts, and nothing runs until the person presses Start.
import { languageName, locale, t, type MessageKey } from "../../i18n";
import type { RunStatus } from "../../store/agent-types";
import type { Check, Group, Purpose, Risk, RiskCode, RunDigest, ScriptHint } from "./types";

export const MAX_BULLETS = 6;
/** Evidence items named in one risk line; the rest is "N more". */
export const MAX_ITEMS = 3;
/** Groups named in the "changed" sentence; the rest is "N other files". */
export const MAX_GROUPS = 3;

/** A run whose summary can be shown: it has ended (done, or stopped with an error). */
export const isFinished = (status: RunStatus | string): boolean => status === "done" || status === "error";

const total = (g: Group) => g.created + g.modified + g.deleted;

/** The evidence of a risk for a list: at most `MAX_ITEMS` names, then "N more". */
function items(evidence: string[], count: number): string[] {
  const shown = evidence.slice(0, MAX_ITEMS);
  const rest = Math.max(count, evidence.length) - shown.length;
  return rest > 0 ? [...shown, t("runsummary.more", { n: rest })] : shown;
}

const risk = (d: RunDigest, code: RiskCode): Risk | undefined => d.risks.find((r) => r.code === code);

/** The "changed" sentence: the largest groups by purpose ("4 screen files and 2 style files"). */
function changedLine(d: RunDigest): string {
  if (d.fileCount === 0) return t("runsummary.b.noFiles");
  const ranked = [...d.groups].filter((g) => total(g) > 0).sort((a, b) => total(b) - total(a));
  const top = ranked.slice(0, MAX_GROUPS);
  const named = top.reduce((n, g) => n + total(g), 0);
  if (top.length === 0) return t("runsummary.b.files", { n: d.fileCount });
  const parts = top.map((g) => t(`runsummary.group.${g.purpose}` as MessageKey, { n: total(g) }));
  const rest = d.fileCount - named;
  if (rest > 0) parts.push(t("runsummary.group.rest", { n: rest }));
  return t("runsummary.b.changed", { items: parts });
}

/**
 * 3 to 6 plain sentences about what the run did (fewer when there is little to say). The most useful ones are kept when
 * there are more; they are shown in a fixed reading order.
 */
export function bullets(d: RunDigest): string[] {
  const out: { at: number; rank: number; text: string }[] = [];
  const add = (at: number, rank: number, text: string | false) => text && out.push({ at, rank, text });
  add(0, 0, changedLine(d));
  add(1, 6, (d.created > 0 || d.deleted > 0) && t("runsummary.b.createdDeleted", { created: d.created, deleted: d.deleted }));
  add(2, 7, d.fileCount > 0 && d.additions + d.deletions > 0 && t("runsummary.b.lines", { added: d.additions, removed: d.deletions }));
  const pkgs = risk(d, "newDependencies");
  add(3, 4, !!pkgs && t("runsummary.b.packages", { n: pkgs.count, names: items(pkgs.evidence, pkgs.count) }));
  const failedCmds = d.commands.filter((c) => c.failed).length;
  add(4, 5, d.commandCount > 0 && t("runsummary.b.commands", { n: d.commandCount, failed: failedCmds }));
  add(5, 2, d.failureCount > 0 && t("runsummary.b.failures", { n: d.failureCount }));
  add(6, 3, d.needsYou > 0 && t("runsummary.b.needsYou", { n: d.needsYou }));
  const last = d.decisions.find((x) => x.kind === "final") ?? d.decisions.find((x) => x.kind === "plan");
  add(7, 1, !!last && t(last.kind === "final" ? "runsummary.b.final" : "runsummary.b.plan", { text: last.text }));
  return out
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_BULLETS)
    .sort((a, b) => a.at - b.at)
    .map((b) => b.text);
}

/** The script a check names: the first dev (else start) script, or the first test script. */
function scriptFor(hints: ScriptHint[] | undefined, groups: string[]): string | undefined {
  for (const g of groups) {
    const s = hints?.find((h) => h.group === g);
    if (s) return s.runner;
  }
  return undefined;
}

function checkLine(c: Check, hints: ScriptHint[] | undefined): string {
  switch (c.code) {
    case "devServer": {
      const cmd = scriptFor(hints, ["dev", "start"]);
      return cmd ? t("runsummary.check.devServerCmd", { cmd }) : t("runsummary.check.devServer");
    }
    case "runTests": {
      const cmd = scriptFor(hints, ["test"]);
      return cmd ? t("runsummary.check.runTestsCmd", { cmd }) : t("runsummary.check.runTests");
    }
    default:
      return t(`runsummary.check.${c.code}` as MessageKey);
  }
}

/** The repositories whose scripts the "what to check" lines may name. */
export const scriptRepos = (d: RunDigest): string[] => [...new Set(d.checks.filter((c) => c.code === "devServer" || c.code === "runTests").flatMap((c) => c.repoIds))];

/**
 * "What to check" lines. `scripts` holds the dev/start/test scripts per repository (names only); with more than one
 * repository in the run, a line names its repository.
 */
export function checkLines(d: RunDigest, scripts: Record<string, ScriptHint[]> = {}, repoName: (id: string) => string = (id) => id): string[] {
  const multi = d.repos.length > 1;
  const out: string[] = [];
  for (const c of d.checks) {
    if (c.repoIds.length === 0) out.push(checkLine(c, undefined));
    for (const id of c.repoIds) {
      const line = checkLine(c, scripts[id]);
      out.push(multi ? t("runsummary.check.inRepo", { repo: repoName(id), line }) : line);
    }
  }
  return [...new Set(out)];
}

export interface RiskLine {
  code: RiskCode;
  text: string;
}

/** One line per risk, with its evidence (paths, package or host names; never contents). */
export function riskLines(d: RunDigest): RiskLine[] {
  return d.risks.map((r) => {
    const list = items(r.evidence, r.evidence.length ? r.count : 0);
    return { code: r.code, text: t(`runsummary.risk.${r.code}` as MessageKey, { n: r.count, items: list, hasItems: list.length ? "yes" : "no" }) };
  });
}

/** The compact chip of the run card: "5 files · 2 risks". */
export const chipText = (d: RunDigest): string => (d.risks.length ? t("runsummary.chip.risks", { files: d.fileCount, risks: d.risks.length }) : t("runsummary.chip.files", { files: d.fileCount }));

const PURPOSE_EN: Record<Purpose, string> = { ui: "screens and components", styles: "styles", tests: "tests", config: "configuration", dependencies: "packages", docs: "documentation", ios: "native iOS", android: "native Android", server: "server code", code: "other code", assets: "images and fonts", other: "other" };

/**
 * The prompt "Explain in plain words" prefills: the digest's facts only (already masked by the backend), never a prompt
 * body, a reply or file contents. The instruction is English; the answer is asked for in the UI language.
 */
export function explainPrompt(d: RunDigest, language: string = languageName(locale(), "en")): string {
  const lines: string[] = [];
  lines.push("Explain in plain, non-technical words what an earlier coding-agent run did, for someone who builds apps by prompting and rarely reads code.");
  lines.push(`Write at most 8 short bullet points, then one line on what to check first. Answer in ${language}.`);
  lines.push("Use only the facts below. Do not run tools, do not open or change files, do not invent anything. A small, fast model is enough for this.");
  lines.push("", "Facts (secrets are already masked):");
  lines.push(`Task title: ${d.title}`);
  lines.push(`Status: ${d.status}`);
  lines.push(`Files: ${d.fileCount} (${d.created} new, ${d.modified} changed, ${d.deleted} deleted), +${d.additions} -${d.deletions} lines`);
  for (const g of d.groups) lines.push(`- ${PURPOSE_EN[g.purpose] ?? g.purpose}: ${total(g)}${g.examples.length ? ` (${g.examples.join(", ")})` : ""}`);
  if (d.commands.length) {
    lines.push(`Commands the agent ran (${d.commandCount}):`);
    for (const c of d.commands) lines.push(`- ${c.text}${c.failed ? ` [failed${c.exitCode !== undefined ? `, exit ${c.exitCode}` : ""}]` : ""}`);
  }
  if (d.decisions.length) {
    lines.push("Plan, tasks and the agent's last message:");
    for (const x of d.decisions) lines.push(`- ${x.kind}${x.kind === "todo" ? (x.done ? " (done)" : " (open)") : ""}: ${x.text}`);
  }
  if (d.checks.length) lines.push(`Suggested checks: ${d.checks.map((c) => c.code).join(", ")}`);
  if (d.risks.length) {
    lines.push("Risks:");
    for (const r of d.risks) lines.push(`- ${r.code} (${r.count})${r.evidence.length ? `: ${r.evidence.join(", ")}` : ""}`);
  }
  for (const f of d.failures) lines.push(`Failed step: ${f}`);
  if (d.needsYou) lines.push(`Requests still waiting for the person: ${d.needsYou}`);
  return lines.join("\n");
}
