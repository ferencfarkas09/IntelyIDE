#!/usr/bin/env node
/**
 * i18n catalog checker (`pnpm i18n:check`). English is the source of truth. For every other catalog:
 *  - the same files and exactly the same keys as English (nothing missing, nothing extra),
 *  - no empty values,
 *  - the same placeholders ({name}) and a valid ICU-lite message,
 *  - plural options use categories valid for the language (and all of them, so `ru` needs one/few/many/other),
 *  - the text is written in the expected script (Arabic letters for ar, Cyrillic for ru, ...),
 *  - length-ratio warnings against English (layout risk) and "still English" warnings.
 * Errors exit 1; warnings are printed but do not fail. `--lang=de,fr` limits the languages, `--quiet` hides warnings.
 *
 * PENDING_NAMESPACES: namespaces whose machine translation is still to come. In every language except `en` and `hu`
 * a missing file or missing key of such a namespace is ONE warning per file (the UI falls back to English); `en` and `hu`
 * stay exact, and keys that ARE present are fully checked (placeholders, ICU, plurals, script, extra keys). Remove a name
 * from the list once its catalogs are translated, so the gate is strict again.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { argNames, choiceKinds, compile } from "../ui/src/i18n/message.ts";
import { LANGUAGES } from "../ui/src/i18n/languages.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const LOCALES_DIR = join(here, "../ui/src/i18n/locales");

/** Wave 9 (roles and Auto, (design notes: roles-orchestration-spec) section 9): `workflow` and `panels` are pending until the orchestrator runs `pnpm i18n:translate -- --all --only-missing` (outside the per-task Haiku budget, D8) and then removes both names. Wave 5: the six MongoDB Studio namespaces ((design notes: mongo-everyone-spec) T1b) `licenses` ((design notes: licensing-spec) L3a, translated in L9) and the three workspace namespaces ((design notes: workspaces-spec) U0). */
export const PENDING_NAMESPACES = ["mongo", "mongoStudio", "mongoLoud", "mongoForm", "mongoDiag", "mongoManage", "licenses", "workspace", "workspaceNew", "workspacePicker", "workflow", "panels", "preview", "providers", "happy", "modes", "mcp", "updates", "memory", "notes", "usage", "sentry", "slash"];
/** The hand-written languages: never exempt, a pending namespace must be complete in them. */
const STRICT_LANGS = new Set(["en", "hu"]);

const SCRIPT_RE = {
  Cyrillic: /\p{Script=Cyrillic}/u,
  Greek: /\p{Script=Greek}/u,
  Arabic: /\p{Script=Arabic}/u,
  Hebrew: /\p{Script=Hebrew}/u,
  Devanagari: /\p{Script=Devanagari}/u,
  Bengali: /\p{Script=Bengali}/u,
  Tamil: /\p{Script=Tamil}/u,
  Telugu: /\p{Script=Telugu}/u,
  Thai: /\p{Script=Thai}/u,
  Han: /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u,
  Hangul: /\p{Script=Hangul}/u,
  Latin: /\p{Script=Latin}/u,
};
const LETTER = /\p{L}/gu;

/** Words that stay in Latin letters in every language (product and git terms); they do not count against the script share. */
const KEEP_LATIN = /(?:\/[\w/.*\-]+|--[\w-]+|\.env\.example|release\/\*)|\b(?:Ferenc|Farkas|commits?|repos?|graph|live|staging|IntelySwitchIDE|IntelyIDE|IntelyHome|Claude|Git|GitHub|Tauri|macOS|Option|Doctor|AI|IDE|INTELY_[A-Z]+|OK|MB|px|URL|HEAD|commit|push|branch|diff|stash|rebase|token|repo|terminal|blame|hunk|cherry-pick|upstream|remote|fetch|fixture|Happy|Agent|MT|release|main|no-verify|env|example)\b/giu;

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const nsFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : []);

/** Texts of a message without ICU syntax, for the script / length checks. */
function plainText(src) {
  const out = [];
  const walk = (nodes) =>
    nodes.forEach((n) => {
      if (typeof n === "string") out.push(n);
      else if (n.t === "choice") Object.values(n.options).forEach(walk);
    });
  walk(compile(src));
  return out.join(" ");
}

export function loadCatalog(lang, dir = LOCALES_DIR) {
  const out = {};
  for (const f of nsFiles(join(dir, lang))) out[f] = readJson(join(dir, lang, f));
  return out;
}

export function checkLanguage(lang, en, dir = LOCALES_DIR, pending = PENDING_NAMESPACES) {
  const errors = [];
  const warnings = [];
  const info = LANGUAGES.find((l) => l.code === lang);
  const err = (m) => errors.push(`${lang}: ${m}`);
  const warn = (m) => warnings.push(`${lang}: ${m}`);
  if (!info) err("not listed in ui/src/i18n/languages.ts");
  let categories = [];
  try {
    categories = new Intl.PluralRules(lang).resolvedOptions().pluralCategories;
  } catch {
    err("Intl.PluralRules does not know this language tag");
  }
  const cat = loadCatalog(lang, dir);
  const isPending = (file) => !STRICT_LANGS.has(lang) && pending.includes(file.replace(/\.json$/, ""));
  for (const f of Object.keys(en)) if (!(f in cat) && !isPending(f)) err(`missing file ${f}`);
  for (const f of Object.keys(cat)) if (!(f in en)) err(`unexpected file ${f}`);
  for (const [file, source] of Object.entries(en)) {
    const target = cat[file];
    const total = Object.keys(source).length;
    if (!target) {
      if (isPending(file) && total) warn(`${file}: pending namespace, file missing (${total} keys fall back to English)`);
      continue;
    }
    if (isPending(file)) {
      const gap = Object.keys(source).filter((key) => !(key in target)).length;
      if (gap) warn(`${file}: pending namespace, ${gap} of ${total} keys not translated yet (English fallback)`);
    } else {
      for (const key of Object.keys(source)) if (!(key in target)) err(`${file}: missing key ${key}`);
    }
    for (const key of Object.keys(target)) if (!(key in source)) err(`${file}: extra key ${key}`);
    for (const [key, value] of Object.entries(target)) {
      const src = source[key];
      if (src === undefined) continue;
      const where = `${file}:${key}`;
      if (typeof value !== "string" || !value.trim()) {
        err(`${where}: empty value`);
        continue;
      }
      let ast;
      try {
        ast = compile(value);
      } catch (e) {
        err(`${where}: invalid message (${e.message})`);
        continue;
      }
      const want = argNames(compile(src)).join(",");
      const got = argNames(ast).join(",");
      if (want !== got) err(`${where}: placeholders {${got}} differ from English {${want}}`);
      for (const { kind, keys } of choiceKinds(ast)) {
        if (kind !== "plural") continue;
        const named = keys.filter((k) => !k.startsWith("="));
        for (const k of named) if (!categories.includes(k)) err(`${where}: plural category "${k}" is not used in ${lang} (${categories.join("/")})`);
        for (const k of categories) if (!named.includes(k)) err(`${where}: plural category "${k}" is missing for ${lang}`);
      }
      const text = plainText(value);
      const letters = (text.replace(KEEP_LATIN, " ").match(LETTER) ?? []);
      const english = plainText(src);
      if (letters.length >= 10 && info) {
        const re = SCRIPT_RE[info.script ?? "Latin"];
        const share = letters.filter((c) => re.test(c)).length / letters.length;
        if (share < 0.3) err(`${where}: only ${(share * 100) | 0}% of the letters are ${info.script ?? "Latin"}`);
      }
      const ratio = text.length / Math.max(1, english.length);
      const cjk = ["ja", "zh-Hans", "zh-Hant", "ko", "th"].includes(lang);
      if (english.length >= 14 && (ratio > 2.2 || ratio < (cjk ? 0.12 : 0.3))) warn(`${where}: length ratio ${ratio.toFixed(2)} vs English`);
      if (english.length >= 24 && value === src && lang !== "en") warn(`${where}: identical to English`);
    }
  }
  return { errors, warnings };
}

export function checkCatalogs({ dir = LOCALES_DIR, langs, pending = PENDING_NAMESPACES } = {}) {
  const en = loadCatalog("en", dir);
  const present = readdirSync(dir).filter((d) => d !== "en" && existsSync(join(dir, d)) && nsFiles(join(dir, d)).length);
  const errors = [];
  const warnings = [];
  for (const name of pending) if (!(`${name}.json` in en)) errors.push(`en: pending namespace ${name} has no English file`);
  for (const [file, cat] of Object.entries(en)) {
    for (const [key, value] of Object.entries(cat)) {
      try {
        compile(value);
      } catch (e) {
        errors.push(`en: ${file}:${key}: invalid message (${e.message})`);
      }
      if (!value.trim()) errors.push(`en: ${file}:${key}: empty value`);
    }
  }
  const todo = langs?.length ? langs : present;
  for (const lang of todo) {
    const r = checkLanguage(lang, en, dir, pending);
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  }
  return { errors, warnings, checked: todo, missingLanguages: LANGUAGES.filter((l) => !l.pseudo && l.code !== "en" && !present.includes(l.code)).map((l) => l.code) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const langs = arg("lang")?.split(",");
  const quiet = process.argv.includes("--quiet");
  const { errors, warnings, checked, missingLanguages } = checkCatalogs({ langs });
  if (!quiet) warnings.forEach((w) => console.log(`warn  ${w}`));
  errors.forEach((e) => console.log(`ERROR ${e}`));
  console.log(`i18n:check ${checked.length} language(s) + en: ${errors.length} error(s), ${warnings.length} warning(s)`);
  if (missingLanguages.length && !langs) console.log(`not translated yet: ${missingLanguages.join(", ")}`);
  console.log(`pending namespaces (warnings only outside en and hu): ${PENDING_NAMESPACES.join(", ")}`);
  process.exit(errors.length ? 1 : 0);
}
