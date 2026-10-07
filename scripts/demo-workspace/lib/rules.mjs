// Content rules for everything the generator writes: the project's own publish-scan RULES plus the generic
// forbidden rules of (design notes: release-ci-spec) 6.8 / 6.2. Owner-specific needles are loaded at run time from the
// untracked local file and never stored in a tracked file.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCAL_NEEDLES_FILE, RULES, loadLocalNeedles } from "../../licenses/publish-scan.mjs";
import { DemoError } from "./errors.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const URL_HOST = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@'"`<>]*@)?([A-Za-z0-9.-]+)/gi;
const SCP_HOST = /\b[a-z][a-z0-9_-]*@([A-Za-z0-9.-]+):(?=[A-Za-z0-9_./~-])/g;
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g;
const HOST_OK = (h) => /^(?:[a-z0-9-]+\.)*example$/i.test(h) || /^(?:[a-z0-9-]+\.)*example\.(?:com|net|org)$/i.test(h);
const MAIL_OK = (h) => HOST_OK(h) || /\.invalid$/i.test(h);

/** Generic rules: each is { id, test(text) -> matched label | null }. */
export const GENERIC_RULES = [
  { id: "users-path", test: (t) => (/\/Users\/(?!Shared\b)[^/\s]+/.test(t) ? "home directory path" : null) },
  { id: "temp-path", test: (t) => (/\/var\/folders\/|\/private\/|(?<![A-Za-z0-9._-])\/tmp\//.test(t) ? "temporary directory path" : null) },
  { id: "temp-name-leak", test: (t) => (/intely-demo|intely-fixture/i.test(t) ? "generator temp-name" : null) },
  {
    id: "non-example-email",
    test: (t) => {
      for (const m of t.matchAll(EMAIL)) if (!MAIL_OK(m[1])) return "e-mail address outside *.example / *.invalid";
      return null;
    },
  },
  {
    id: "non-example-url",
    test: (t) => {
      for (const m of t.matchAll(URL_HOST)) if (!HOST_OK(m[1])) return "URL host outside example.com / *.example";
      for (const m of t.matchAll(SCP_HOST)) if (!HOST_OK(m[1])) return "scp-style host outside example.com / *.example";
      return null;
    },
  },
];

/** Loads the owner's local needles (null when the file is absent). */
export function loadNeedles({ required = false, file = null, root = REPO_ROOT } = {}) {
  const path = file ?? join(root, LOCAL_NEEDLES_FILE);
  if (!existsSync(path)) {
    if (required) throw new DemoError(`local needles required but ${path} is missing`, 1);
    return null;
  }
  return loadLocalNeedles(root, path);
}

/**
 * Scans `text`. `where` is a label that is reported, the matched text never is. `name` is a repo-relative file
 * name for rules restricted to file kinds. Returns [{ rule, where }].
 */
export function scanText(where, text, { needles = null, name = "" } = {}) {
  const hits = [];
  for (const r of RULES) {
    if (r.files && !r.files.test(name)) continue;
    r.re.lastIndex = 0;
    if (r.re.test(text)) hits.push({ rule: r.id, where });
  }
  for (const g of GENERIC_RULES) {
    const m = g.test(text);
    if (m) hits.push({ rule: g.id, where });
  }
  if (needles) {
    for (const r of needles.rules) {
      r.re.lastIndex = 0;
      if (r.re.test(text)) hits.push({ rule: `local:${r.id}`, where });
    }
    const low = text.toLowerCase();
    needles.literals.forEach((l, i) => {
      if (low.includes(l.toLowerCase())) hits.push({ rule: `local-literal#${i}`, where });
    });
  }
  return hits;
}

/** Scans many [where, text] pairs and returns every hit. */
export function scanAll(pairs, opts = {}) {
  const out = [];
  for (const [where, text] of pairs) out.push(...scanText(where, text, { ...opts, name: opts.nameOf ? opts.nameOf(where) : "" }));
  return out;
}

export function formatHits(hits, max = 20) {
  const lines = hits.slice(0, max).map((h) => `  ${h.rule}: ${h.where}`);
  if (hits.length > max) lines.push(`  ... and ${hits.length - max} more`);
  return lines.join("\n");
}
