#!/usr/bin/env node
/**
 * Machine-translates the English catalogs (ui/src/i18n/locales/en/*.json) with the `claude` CLI (Haiku by default).
 *
 *   node scripts/i18n-translate.mjs --lang=de,fr          translate these languages (writes locales/<lang>/*.json)
 *   node scripts/i18n-translate.mjs --all                 every shipped language except en and hu (hu is hand written)
 *   node scripts/i18n-translate.mjs --all --only-missing  skip languages whose catalog is already complete
 *   node scripts/i18n-translate.mjs --all --fill-missing  only translate keys that English has and the catalog lacks (after adding strings)
 *   node scripts/i18n-translate.mjs --all --fix-errors    re-ask only the keys that i18n-check flags (left in Latin script, wrong plural forms, ...)
 *   node scripts/i18n-translate.mjs --backcheck=de,fr     back-translate 12 sampled strings to English and score the overlap
 *
 * Budget and load: at most 3 calls in flight, at most --max-calls (default 400) calls per process and per state file
 * (.scratch/i18n-translate/state.json). Batches of ~60 strings per language, then validation (placeholders, plural
 * categories, script) and up to two repair rounds for the failed keys only.
 * No dependencies. The model never sees the repository: calls run in an empty temp directory with no tools.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LANGUAGES } from "../ui/src/i18n/languages.ts";
import { argNames, choiceKinds, compile } from "../ui/src/i18n/message.ts";
import { LOCALES_DIR, checkLanguage, loadCatalog } from "./i18n-check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const WORK = join(here, "../.scratch/i18n-translate");
const STATE = join(WORK, "state.json");
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const flag = (name) => process.argv.includes(`--${name}`);

const MODEL = arg("model") ?? "haiku";
const CONCURRENCY = Math.min(8, Number(arg("concurrency") ?? 3));
const MAX_CALLS = Number(arg("max-calls") ?? 400);
const BATCH = Number(arg("batch") ?? 60);

mkdirSync(WORK, { recursive: true });
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { calls: 0, log: [] };
const saveState = () => writeFileSync(STATE, JSON.stringify(state, null, 1));

/** How each language should be written; anything not listed is "the standard written language, formal-neutral UI tone". */
const NOTES = {
  "pt-PT": "European Portuguese (Portugal): use 'ficheiro', 'eliminar', 'ecrã', gerund-free infinitive style.",
  "pt-BR": "Brazilian Portuguese: use 'arquivo', 'excluir', 'tela'.",
  sr: "Serbian in the CYRILLIC script (not Latin).",
  bs: "Bosnian in the LATIN script.",
  hr: "Croatian (Latin script).",
  nb: "Norwegian Bokmal.",
  fil: "Filipino (Tagalog-based), natural UI Taglish is acceptable for technical terms.",
  "zh-Hans": "Simplified Chinese for mainland China; no spaces between CJK and Latin is fine.",
  "zh-Hant": "Traditional Chinese for Taiwan.",
  ja: "Japanese, polite です/ます style, katakana for loanwords.",
  ko: "Korean, polite 합니다/하세요 style.",
  ar: "Modern Standard Arabic.",
  fa: "Persian (Farsi) with Persian orthography (ک ی).",
  ur: "Urdu in Nastaliq-compatible Arabic script.",
  he: "Modern Hebrew (unpointed).",
  ms: "Malay (Malaysia).",
  id: "Indonesian.",
  mk: "Macedonian (Cyrillic).",
  sw: "Swahili.",
  af: "Afrikaans.",
};

const GLOSSARY = `Glossary. These developer terms keep their usual local form: use the established loanword/transliteration where the language's developers say it that way (for example ja コミット, ko 커밋, ru коммит, uk коміт, ar كوميت or commit, hi कमिट), otherwise keep the Latin word unchanged:
commit, push, pull, fetch, branch, merge, rebase, cherry-pick, stash, diff, blame, hunk, staging, upstream, remote, repo / repository (use the usual word for a Git repository), token, terminal, workspace, tab, agent (AI agent), Doctor (a diagnostics panel, keep as a name).
Never translate or alter: IntelySwitchIDE, IntelyIDE, IntelyHome, Claude, Git, GitHub, Happy, Tauri, macOS, Option, environment variable names (INTELY_READONLY, INTELY_WRITABLE, INTELY_E2E), file names and paths (.env.example, /Users/you/Projects/app), glob patterns (release/*, main), command flags (--no-verify), hex colours (#2a9d8f), the personal name Ferenc Farkas.`;

let strict = false;
function system(lang) {
  const info = LANGUAGES.find((l) => l.code === lang);
  let cats = "one, other";
  try {
    cats = new Intl.PluralRules(lang).resolvedOptions().pluralCategories.join(", ");
  } catch {}
  return `You are a professional software localizer translating the UI of a desktop developer tool (a multi-repository Git IDE with AI agents) from English into ${lang} (${NOTES[lang] ?? "standard written language, neutral polite UI tone"}).
Rules:
1. Input is a JSON object {"<id>": "<English text>"}. Output ONLY a JSON object with exactly the same ids and the translated texts. No commentary, no code fences.
2. Keep every placeholder like {name}, {count}, {title} exactly as written (same names, never translated, never added or dropped). Move them where the grammar needs.
3. Messages may use ICU plural syntax: {count, plural, one {# file} other {# files}}. Keep the structure and the word 'plural'. Inside the options use ONLY these plural categories for ${lang}, all of them present: ${cats}. (The categories 'one', 'few', 'many', 'other' etc. stay in English letters; '#' stands for the number.) Exact matches like =0 are allowed.
4. UI strings must be concise and natural; same register as common software in ${lang}. Do not add punctuation or text that the English lacks; keep a trailing period or ellipsis if the English has one. Keep ← → ... and the "…" character.
5. The id suffix tells the context (e.g. *.Ph = placeholder, *.aria / *Label = screen-reader label, *.title = heading).
6. Write the language in its normal script${info?.script ? ` (${info.script})` : ""}. ${info?.rtl ? "It is a right-to-left language: do not insert direction marks." : ""}
${GLOSSARY}${strict ? `\nIMPORTANT: a previous attempt left these strings in English or in Latin letters. Translate EVERY word into ${lang} in its own script. Where developers in that language really use a Latin loanword (commit, push, branch, diff) it may stay, but ordinary words (workspace, repositories, name, path, violet, dev servers, scripts, no commits ...) must be written in the native script (transliterate if there is no native word).` : ""}`;
}

let inflight = 0;
const waiters = [];
const slot = async () => {
  if (inflight >= CONCURRENCY) await new Promise((r) => waiters.push(r));
  inflight++;
};
const release = () => {
  inflight--;
  waiters.shift()?.();
};

async function callModel(systemPrompt, userPrompt, label) {
  if (state.calls >= MAX_CALLS) throw new Error(`call budget of ${MAX_CALLS} reached`);
  await slot();
  state.calls++;
  saveState();
  try {
    const out = await new Promise((resolve, reject) => {
      const args = ["-n", "10", "claude", "-p", "--model", MODEL, "--tools", "", "--setting-sources", "", "--disable-slash-commands", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", systemPrompt, "--output-format", "json"];
      const child = spawn("nice", args, { cwd: WORK, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`claude exited ${code}: ${stderr.slice(0, 300)}`))));
      child.stdin.end(userPrompt);
    });
    const res = JSON.parse(out);
    if (res.is_error) throw new Error(`model error: ${String(res.result).slice(0, 200)}`);
    state.log.push({ label, cost: res.total_cost_usd, at: new Date().toISOString() });
    saveState();
    return String(res.result ?? "");
  } finally {
    release();
  }
}

function parseJsonObject(text) {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("no JSON object in the answer");
  const body = text.slice(a, b + 1);
  try {
    return JSON.parse(body);
  } catch (strictError) {
    // The model sometimes leaves a raw double quote inside a value (typographic quotes written as ASCII). The answer mirrors
    // our one-entry-per-line request, so parse line by line and escape the unescaped quotes inside each value.
    const out = {};
    for (const line of body.split("\n")) {
      const m = line.match(/^\s*"([^"]+)"\s*:\s*"(.*)"\s*,?\s*$/);
      if (!m) continue;
      try {
        out[m[1]] = JSON.parse(`"${m[2].replace(/(?<!\\)"/g, '\\"')}"`);
      } catch {
        // leave this entry out; the retry round asks for it again
      }
    }
    if (!Object.keys(out).length) throw strictError;
    return out;
  }
}

/** Per-string validation, same rules as i18n-check. Returns an error text or null. */
function problem(lang, en, value) {
  if (typeof value !== "string" || !value.trim()) return "empty";
  let ast;
  try {
    ast = compile(value);
  } catch (e) {
    return `invalid ICU syntax (${e.message})`;
  }
  const want = argNames(compile(en)).join(",");
  const got = argNames(ast).join(",");
  if (want !== got) return `placeholders {${got}} must be {${want}}`;
  const cats = new Intl.PluralRules(lang).resolvedOptions().pluralCategories;
  for (const { kind, keys } of choiceKinds(ast)) {
    if (kind !== "plural") continue;
    const named = keys.filter((k) => !k.startsWith("="));
    if (named.slice().sort().join() !== cats.slice().sort().join()) return `plural options must be exactly: ${cats.join(", ")} (got ${named.join(", ")})`;
  }
  return null;
}

async function translateBatch(lang, entries) {
  const pending = { ...entries };
  const done = {};
  let notes = {};
  for (let round = 0; round < 3 && Object.keys(pending).length; round++) {
    const hint = Object.keys(notes).length ? `\nYour previous answer had problems; fix exactly these:\n${JSON.stringify(notes)}\n` : "";
    let answer;
    try {
      answer = parseJsonObject(await callModel(system(lang), `${hint}Translate:\n${JSON.stringify(pending, null, 1)}`, `${lang} r${round} n=${Object.keys(pending).length}`));
    } catch (e) {
      console.error(`  ${lang}: ${e.message}`);
      if (/budget/.test(e.message)) throw e;
      notes = {};
      continue;
    }
    notes = {};
    for (const id of Object.keys(pending)) {
      const why = problem(lang, pending[id], answer[id]);
      if (why) notes[id] = why;
      else (done[id] = answer[id].trim(), delete pending[id]);
    }
  }
  return { done, failed: pending };
}

async function translateLanguage(lang) {
  const en = loadCatalog("en");
  const flat = {};
  for (const [file, cat] of Object.entries(en)) for (const [k, v] of Object.entries(cat)) flat[`${file.replace(".json", "")}::${k}`] = v;
  const existing = flag("fill-missing") || flag("fix-errors") ? loadCatalog(lang) : {};
  let only = null;
  if (flag("fix-errors")) {
    strict = true;
    only = new Set(checkLanguage(lang, loadCatalog("en")).errors.flatMap((e) => { const m = e.match(/^[\w-]+: (\w+)\.json:([^:]+): /); return m ? [`${m[1]}::${m[2]}`] : []; }));
  }
  const have = (id) => {
    const [ns, ...k] = id.split("::");
    return existing[`${ns}.json`]?.[k.join("::")] !== undefined;
  };
  const ids = Object.keys(flat).filter((id) => (only ? only.has(id) : !flag("fill-missing") || !have(id)));
  if (!ids.length) return { lang, failedCount: 0, errors: 0 };
  const batches = [];
  for (let i = 0; i < ids.length; i += BATCH) batches.push(Object.fromEntries(ids.slice(i, i + BATCH).map((id) => [id, flat[id]])));
  const results = await Promise.all(batches.map((b) => translateBatch(lang, b)));
  const done = Object.assign({}, ...results.map((r) => r.done));
  const failed = Object.assign({}, ...results.map((r) => r.failed));
  const dir = join(LOCALES_DIR, lang);
  mkdirSync(dir, { recursive: true });
  for (const [file, cat] of Object.entries(en)) {
    const ns = file.replace(".json", "");
    const out = {};
    for (const k of Object.keys(cat)) out[k] = done[`${ns}::${k}`] ?? existing[file]?.[k] ?? cat[k];
    writeFileSync(join(dir, file), JSON.stringify(out, null, 2) + "\n");
  }
  const failedCount = Object.keys(failed).length;
  const report = checkLanguage(lang, en);
  console.log(`${lang}: ${ids.length - failedCount}/${ids.length} translated${failedCount ? `, ${failedCount} kept in English` : ""}; check: ${report.errors.length} error(s), ${report.warnings.length} warning(s); calls so far ${state.calls}`);
  report.errors.slice(0, 5).forEach((e) => console.log(`    ${e}`));
  return { lang, failedCount, errors: report.errors.length };
}

async function pool(items, worker) {
  const out = [];
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        out.push(await worker(item));
      } catch (e) {
        console.error(`${item}: ${e.message}`);
        out.push({ lang: item, failedCount: -1, errors: -1 });
        if (/budget/.test(e.message)) return;
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, run));
  return out;
}

// ---- back-translation spot check ---------------------------------------------------------------------------------------

const tokens = (s) => new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2));
const overlap = (a, b) => {
  const [x, y] = [tokens(a), tokens(b)];
  const inter = [...x].filter((w) => y.has(w)).length;
  return inter / Math.max(1, new Set([...x, ...y]).size);
};

async function backcheck(lang) {
  const en = loadCatalog("en");
  const tr = loadCatalog(lang);
  const flat = [];
  for (const [file, cat] of Object.entries(en)) for (const k of Object.keys(cat)) if (cat[k].length > 20 && !cat[k].includes("plural")) flat.push([`${file}:${k}`, cat[k], tr[file]?.[k] ?? ""]);
  const sample = flat.filter((_, i) => i % Math.floor(flat.length / 12) === 0).slice(0, 12);
  const payload = Object.fromEntries(sample.map(([id, , t]) => [id, t]));
  const back = parseJsonObject(await callModel(`You translate UI strings from ${lang} to English literally. Keep {placeholders}. Output ONLY a JSON object with the same ids.`, JSON.stringify(payload, null, 1), `back ${lang}`));
  const rows = sample.map(([id, source]) => ({ id, source, back: String(back[id] ?? ""), score: overlap(source, String(back[id] ?? "")) }));
  const avg = rows.reduce((s, r) => s + r.score, 0) / rows.length;
  writeFileSync(join(WORK, `backcheck-${lang}.json`), JSON.stringify({ lang, avg, rows }, null, 1));
  console.log(`${lang}: back-translation word overlap ${(avg * 100).toFixed(0)}% over ${rows.length} strings; weakest: ${rows.sort((a, b) => a.score - b.score).slice(0, 2).map((r) => `${r.id} (${(r.score * 100).toFixed(0)}%)`).join(", ")}`);
  return { lang, avg };
}

const main = async () => {
  const back = arg("backcheck")?.split(",");
  if (back) return void (await pool(back, backcheck));
  let langs = arg("lang")?.split(",") ?? [];
  if (flag("all")) langs = LANGUAGES.filter((l) => !l.pseudo && !l.reviewed).map((l) => l.code);
  if (flag("only-missing")) {
    const en = loadCatalog("en");
    langs = langs.filter((l) => checkLanguage(l, en).errors.length > 0);
  }
  if ((flag("fill-missing") || flag("fix-errors")) && !langs.length) langs = LANGUAGES.filter((l) => !l.pseudo && !l.reviewed).map((l) => l.code);
  if (!langs.length) return void console.log("nothing to do: pass --lang=de,fr or --all");
  if (flag("dry")) return void console.log(`would translate ${langs.length} language(s): ${langs.join(" ")}; calls used so far ${state.calls}/${MAX_CALLS}`);
  console.log(`translating ${langs.length} language(s) with ${MODEL}, ${CONCURRENCY} in flight, calls used ${state.calls}/${MAX_CALLS}`);
  const results = await pool(langs, translateLanguage);
  const bad = results.filter((r) => r.failedCount !== 0 || r.errors !== 0);
  console.log(`done. ${results.length - bad.length} clean, ${bad.length} need attention${bad.length ? `: ${bad.map((b) => b.lang).join(" ")}` : ""}. Calls: ${state.calls}/${MAX_CALLS}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
