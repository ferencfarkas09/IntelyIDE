// Validator for repo data modules (schema documented in README.md). Pure: no file system, no git.
import { anchorWindow } from "./brand.mjs";
import { DemoError } from "./errors.mjs";
import { relPathProblem } from "./fs.mjs";

export const REQUIRED_KEYS = ["id", "name", "branch", "files", "history", "worktree", "agentEdit"];
export const OPTIONAL_KEYS = ["upstream", "upstreamExtra", "remoteOnlyBranches", "hooks", "expect"];
export const WORKTREE_KEYS = ["modify", "stageAdd", "delete", "stageRename", "stage", "thenModify", "untracked", "hunkTargets"];
export const MAX_FILE_BYTES = 200 * 1024;

const ID_RE = /^[a-z][a-z0-9-]{0,30}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;
const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function refProblem(r) {
  if (typeof r !== "string" || !REF_RE.test(r)) return "must match " + REF_RE;
  if (r.includes("..") || r.includes("//") || r.endsWith("/") || r.endsWith(".") || r.endsWith(".lock") || r.split("/").some((s) => s.startsWith("."))) return "is not a valid git ref name";
  return null;
}

function textProblem(t) {
  if (typeof t !== "string") return "must be a string";
  if (!t.isWellFormed()) return "is not valid UTF-8 (lone surrogate)";
  if (t.includes("\0")) return "contains NUL";
  if (t.includes("�")) return "contains U+FFFD (a decoding error leaked into the data)";
  if (Buffer.byteLength(t, "utf8") > MAX_FILE_BYTES) return `is larger than ${MAX_FILE_BYTES} bytes`;
  return null;
}

/** A file value is a string or { text, exec }. */
function fileValueProblem(v) {
  if (typeof v === "string") return textProblem(v);
  if (isObj(v) && typeof v.text === "string" && (v.exec === undefined || typeof v.exec === "boolean")) return textProblem(v.text);
  return "must be a string or { text, exec? }";
}

export const fileText = (v) => (typeof v === "string" ? v : v.text);
export const fileExec = (v) => typeof v === "object" && v.exec === true;

/** Returns a list of problems (empty = valid). `brand` supplies authors and the anchor window. */
export function validateModule(mod, brand) {
  const p = [];
  const bad = (where, msg) => p.push(`${where}: ${msg}`);
  if (!isObj(mod)) return ["module: default export must be an object"];
  for (const k of REQUIRED_KEYS) if (!(k in mod)) bad(k, "missing required key");
  for (const k of Object.keys(mod)) if (![...REQUIRED_KEYS, ...OPTIONAL_KEYS].includes(k)) bad(k, "unknown key");
  if (p.length && REQUIRED_KEYS.some((k) => !(k in mod))) return p;

  if (typeof mod.id !== "string" || !ID_RE.test(mod.id)) bad("id", `must match ${ID_RE}`);
  if (typeof mod.name !== "string" || !mod.name.trim()) bad("name", "must be a non-empty string");
  else if (textProblem(mod.name)) bad("name", textProblem(mod.name));
  if (refProblem(mod.branch)) bad("branch", refProblem(mod.branch));

  // files
  const filePaths = new Set();
  if (!isObj(mod.files) || !Object.keys(mod.files).length) bad("files", "must be a non-empty object path -> content");
  else {
    const lower = new Set();
    for (const [path, v] of Object.entries(mod.files)) {
      const pp = relPathProblem(path);
      if (pp) bad(`files[${JSON.stringify(path)}]`, pp);
      else if (lower.has(path.toLowerCase())) bad(`files[${JSON.stringify(path)}]`, "duplicate path (case-insensitive)");
      lower.add(path.toLowerCase());
      filePaths.add(path);
      const tp = fileValueProblem(v);
      if (tp) bad(`files[${JSON.stringify(path)}]`, tp);
    }
  }

  const [lo, hi] = anchorWindow(brand);
  const authorOk = (a) => typeof a === "string" && Object.hasOwn(brand.authors, a);
  const stepProblems = (step, where, { allowBranchy }) => {
    if (!isObj(step)) return bad(where, "must be an object");
    const known = ["at", "author", "message", "changes", ...(allowBranchy ? ["branch", "merge", "tag"] : [])];
    for (const k of Object.keys(step)) if (!known.includes(k)) bad(`${where}.${k}`, "unknown key");
    if (typeof step.at !== "string" || !AT_RE.test(step.at) || Number.isNaN(Date.parse(step.at))) bad(`${where}.at`, "must be an ISO instant like 2026-09-01T10:15:00Z");
    else {
      const t = Date.parse(step.at);
      if (t < lo || t > hi) bad(`${where}.at`, `${step.at} is outside the anchor window ${brand.anchor.start}..${brand.anchor.end}`);
    }
    if (!authorOk(step.author)) bad(`${where}.author`, `must be one of ${Object.keys(brand.authors).join(", ")}`);
    if (typeof step.message !== "string" || !step.message.trim()) bad(`${where}.message`, "must be a non-empty string");
    else {
      const tp = textProblem(step.message);
      if (tp) bad(`${where}.message`, tp);
      const subject = step.message.split("\n")[0];
      if (subject.length > 100) bad(`${where}.message`, "subject is longer than 100 characters");
      if (step.message !== step.message.trim()) bad(`${where}.message`, "must not start or end with whitespace");
    }
    const hasChanges = isObj(step.changes) && Object.keys(step.changes).length > 0;
    if (step.changes !== undefined && !isObj(step.changes)) bad(`${where}.changes`, "must be an object");
    if (step.merge !== undefined) {
      if (!isObj(step.merge) || refProblem(step.merge.from) || typeof step.merge.message !== "string" || !step.merge.message.trim()) bad(`${where}.merge`, "must be { from: <branch>, message }");
      else if (textProblem(step.merge.message)) bad(`${where}.merge.message`, textProblem(step.merge.message));
      if (hasChanges) bad(`${where}`, "a merge step cannot also carry changes");
    } else if (!hasChanges) bad(`${where}.changes`, "a step needs at least one change (or a merge)");
    if (isObj(step.changes)) {
      const lower = new Set();
      for (const [path, v] of Object.entries(step.changes)) {
        const w = `${where}.changes[${JSON.stringify(path)}]`;
        const pp = relPathProblem(path);
        if (pp) bad(w, pp);
        else if (lower.has(path.toLowerCase())) bad(w, "duplicate path (case-insensitive)");
        lower.add(path.toLowerCase());
        if (v === null) continue;
        if (isObj(v) && "renameFrom" in v) {
          const rp = relPathProblem(v.renameFrom);
          if (rp) bad(`${w}.renameFrom`, rp);
          if (v.text !== undefined && textProblem(v.text)) bad(`${w}.text`, textProblem(v.text));
          if (v.renameFrom === path) bad(w, "renameFrom equals the path");
          continue;
        }
        const tp = fileValueProblem(v);
        if (tp) bad(w, tp);
      }
    }
    if (allowBranchy) {
      if (step.branch !== undefined && refProblem(step.branch)) bad(`${where}.branch`, refProblem(step.branch));
      if (step.tag !== undefined) {
        const name = typeof step.tag === "string" ? step.tag : step.tag?.name;
        if (refProblem(name)) bad(`${where}.tag`, refProblem(name) ?? "invalid");
        if (isObj(step.tag) && step.tag.message !== undefined && textProblem(step.tag.message)) bad(`${where}.tag.message`, textProblem(step.tag.message));
      }
    }
  };

  // history
  if (!Array.isArray(mod.history) || !mod.history.length) bad("history", "must be a non-empty array");
  else {
    let prev = -Infinity;
    const branches = new Set();
    const tags = new Set();
    let cur = "main";
    mod.history.forEach((step, i) => {
      const where = `history[${i}]`;
      stepProblems(step, where, { allowBranchy: true });
      if (!isObj(step)) return;
      const t = Date.parse(step.at);
      if (!Number.isNaN(t)) {
        if (t < prev) bad(`${where}.at`, "dates must not go backwards");
        prev = t;
      }
      if (typeof step.branch === "string") cur = step.branch;
      if (i === 0 && step.merge) bad(where, "the first step cannot be a merge");
      if (i === 0 && step.branch !== undefined && step.branch !== "main") bad(`${where}.branch`, "the first step commits on main");
      if (i === 0) branches.add("main");
      else if (typeof step.branch === "string" && !branches.has(step.branch)) {
        // created from the current HEAD on first use
      }
      branches.add(cur);
      if (step.merge && typeof step.merge.from === "string") {
        if (step.merge.from === cur) bad(`${where}.merge.from`, "cannot merge a branch into itself");
        else if (!branches.has(step.merge.from)) bad(`${where}.merge.from`, `branch ${step.merge.from} has no earlier commit`);
      }
      const tag = typeof step.tag === "string" ? step.tag : step.tag?.name;
      if (tag) {
        if (tags.has(tag)) bad(`${where}.tag`, `duplicate tag ${tag}`);
        tags.add(tag);
      }
    });
    if (!branches.has(mod.branch)) bad("branch", `${mod.branch} never receives a commit in history`);
  }

  // worktree
  if (!isObj(mod.worktree)) bad("worktree", "must be an object");
  else {
    const w = mod.worktree;
    for (const k of Object.keys(w)) if (!WORKTREE_KEYS.includes(k)) bad(`worktree.${k}`, "unknown key");
    const seen = new Map();
    const touch = (path, kind, where) => {
      const pp = relPathProblem(path);
      if (pp) return bad(where, pp);
      const prevKind = seen.get(path);
      if (prevKind && !(kind === "stage" || kind === "thenModify" || prevKind === "stage")) bad(where, `path is also used by worktree.${prevKind}`);
      if (!prevKind) seen.set(path, kind);
    };
    for (const k of ["modify", "stageAdd", "thenModify", "untracked"]) {
      if (w[k] === undefined) continue;
      if (!isObj(w[k])) {
        bad(`worktree.${k}`, "must be an object path -> content");
        continue;
      }
      for (const [path, v] of Object.entries(w[k])) {
        touch(path, k === "thenModify" ? "thenModify" : k, `worktree.${k}[${JSON.stringify(path)}]`);
        const tp = fileValueProblem(v);
        if (tp) bad(`worktree.${k}[${JSON.stringify(path)}]`, tp);
      }
    }
    for (const k of ["delete", "stage"]) {
      if (w[k] === undefined) continue;
      if (!Array.isArray(w[k])) {
        bad(`worktree.${k}`, "must be an array of paths");
        continue;
      }
      w[k].forEach((path, i) => touch(path, k, `worktree.${k}[${i}]`));
    }
    if (w.stageRename !== undefined) {
      if (!Array.isArray(w.stageRename)) bad("worktree.stageRename", "must be an array of { from, to, text? }");
      else
        w.stageRename.forEach((r, i) => {
          const where = `worktree.stageRename[${i}]`;
          if (!isObj(r)) return bad(where, "must be { from, to, text? }");
          for (const f of ["from", "to"]) {
            const pp = relPathProblem(r[f]);
            if (pp) bad(`${where}.${f}`, pp);
          }
          if (r.from === r.to) bad(where, "from equals to");
          if (r.text !== undefined && textProblem(r.text)) bad(`${where}.text`, textProblem(r.text));
        });
    }
    for (const path of w.stage ?? []) if (typeof path === "string" && !(path in (w.modify ?? {}))) bad("worktree.stage", `${path} is not in worktree.modify`);
    for (const path of Object.keys(w.thenModify ?? {})) if (!(w.stage ?? []).includes(path)) bad("worktree.thenModify", `${path} must also be listed in worktree.stage`);
    if (w.hunkTargets !== undefined) {
      if (!Array.isArray(w.hunkTargets)) bad("worktree.hunkTargets", "must be an array of { path, hunks }");
      else
        w.hunkTargets.forEach((h, i) => {
          if (!isObj(h) || relPathProblem(h.path) || !Number.isInteger(h.hunks) || h.hunks < 1) bad(`worktree.hunkTargets[${i}]`, "must be { path, hunks >= 1 }");
        });
    }
  }

  // agentEdit
  if (!isObj(mod.agentEdit)) bad("agentEdit", "must be { path, before, after }");
  else {
    const a = mod.agentEdit;
    const pp = relPathProblem(a.path);
    if (pp) bad("agentEdit.path", pp);
    for (const k of ["before", "after"]) {
      const tp = textProblem(a[k]);
      if (tp) bad(`agentEdit.${k}`, tp);
    }
    if (typeof a.before === "string" && a.before === a.after) bad("agentEdit", "before equals after");
    if (typeof a.before === "string" && !a.before.length) bad("agentEdit.before", "must not be empty");
  }

  // upstream / extra / remote-only branches
  const up = mod.upstream ?? { ahead: 0, behind: 0 };
  if (!isObj(up) || !Number.isInteger(up.ahead) || up.ahead < 0 || !Number.isInteger(up.behind ?? 0) || (up.behind ?? 0) < 0) bad("upstream", "must be { ahead >= 0, behind >= 0 } (integers)");
  else {
    const n = (mod.upstreamExtra ?? []).length;
    if ((up.behind ?? 0) !== n) bad("upstreamExtra", `needs exactly upstream.behind (${up.behind ?? 0}) steps, found ${n}`);
    if (Array.isArray(mod.history) && up.ahead >= mod.history.length) bad("upstream.ahead", "is larger than the history");
  }
  if (mod.upstreamExtra !== undefined) {
    if (!Array.isArray(mod.upstreamExtra)) bad("upstreamExtra", "must be an array of steps");
    else mod.upstreamExtra.forEach((s, i) => stepProblems(s, `upstreamExtra[${i}]`, { allowBranchy: false }));
  }
  if (mod.remoteOnlyBranches !== undefined) {
    if (!Array.isArray(mod.remoteOnlyBranches)) bad("remoteOnlyBranches", "must be an array of { name, from }");
    else
      mod.remoteOnlyBranches.forEach((b, i) => {
        if (!isObj(b) || refProblem(b.name) || refProblem(b.from)) bad(`remoteOnlyBranches[${i}]`, "must be { name, from } with valid ref names");
      });
  }
  if (mod.hooks !== undefined && (!isObj(mod.hooks) || Object.entries(mod.hooks).some(([k, v]) => !/^[a-z-]+$/.test(k) || typeof v !== "string" || textProblem(v)))) bad("hooks", "must be { <hook-name>: script text }");
  if (mod.expect !== undefined && !isObj(mod.expect)) bad("expect", "must be an object (see lib/outcomes.mjs)");
  return p;
}

export function assertModule(mod, brand, label = "module") {
  const problems = validateModule(mod, brand);
  if (problems.length) throw new DemoError(`${label} is invalid:\n  - ${problems.join("\n  - ")}`, 1);
}

/** Every text a module can put into a repository, as [label, text] pairs (file names included), for rule scans. */
export function moduleTexts(mod) {
  const out = [[`${mod.id}: id`, mod.id], [`${mod.id}: name`, mod.name], [`${mod.id}: branch`, mod.branch]];
  const add = (label, t) => out.push([`${mod.id}: ${label}`, t]);
  for (const [p, v] of Object.entries(mod.files)) {
    add(`file name ${p}`, p);
    add(`file ${p}`, fileText(v));
  }
  const steps = [...mod.history.map((s, i) => [`history[${i}]`, s]), ...(mod.upstreamExtra ?? []).map((s, i) => [`upstreamExtra[${i}]`, s])];
  for (const [where, s] of steps) {
    add(`${where} message`, s.message);
    if (s.merge) add(`${where} merge message`, s.merge.message);
    if (s.branch) add(`${where} branch`, s.branch);
    if (s.tag) add(`${where} tag`, typeof s.tag === "string" ? s.tag : `${s.tag.name}\n${s.tag.message ?? ""}`);
    for (const [p, v] of Object.entries(s.changes ?? {})) {
      add(`${where} change name ${p}`, p);
      if (typeof v === "string") add(`${where} change ${p}`, v);
      else if (v && typeof v === "object") add(`${where} change ${p}`, `${v.renameFrom ?? ""}\n${v.text ?? fileText(v) ?? ""}`);
    }
  }
  const w = mod.worktree;
  for (const k of ["modify", "stageAdd", "thenModify", "untracked"]) for (const [p, v] of Object.entries(w[k] ?? {})) {
    add(`worktree.${k} name ${p}`, p);
    add(`worktree.${k} ${p}`, fileText(v));
  }
  for (const r of w.stageRename ?? []) add(`worktree.stageRename ${r.to}`, `${r.from}\n${r.to}\n${r.text ?? ""}`);
  for (const p of [...(w.delete ?? [])]) add("worktree.delete name", p);
  add("agentEdit", `${mod.agentEdit.path}\n${mod.agentEdit.before}\n${mod.agentEdit.after}`);
  for (const [k, v] of Object.entries(mod.hooks ?? {})) add(`hook ${k}`, v);
  for (const b of mod.remoteOnlyBranches ?? []) add("remoteOnlyBranches", `${b.name}\n${b.from}`);
  return out;
}
