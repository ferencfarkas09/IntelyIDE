/**
 * The i18n runtime: `t(key, params)` reads a Solid signal, so a call inside JSX or an effect follows the language.
 * Catalogs are JSON files `locales/<lang>/<namespace>.json` with flat `area.thing` keys (the namespace is the file, for
 * ownership and lazy loading). English is bundled; every other language is a lazy chunk fetched only when it is the active
 * one. Lookup: lang-region -> lang -> en. Messages are ICU-lite, see message.ts.
 */
import { createSignal } from "solid-js";
import { readStored, writeStored } from "../ui-kit/storage";
import enPlatform from "./locales/en/platform.json";
import enShell from "./locales/en/shell.json";
import enSettings from "./locales/en/settings.json";
import enAbout from "./locales/en/about.json";
import enComponents from "./locales/en/components.json";
import enPanels from "./locales/en/panels.json";
import enWorkflow from "./locales/en/workflow.json";
import enExtras from "./locales/en/extras.json";
import enPreview from "./locales/en/preview.json";
import enGitx from "./locales/en/gitx.json";
import enAgentux from "./locales/en/agentux.json";
import enProviders from "./locales/en/providers.json";
import enContract from "./locales/en/contract.json";
import enMongo from "./locales/en/mongo.json";
import enMongoStudio from "./locales/en/mongoStudio.json";
import enMongoLoud from "./locales/en/mongoLoud.json";
import enMongoForm from "./locales/en/mongoForm.json";
import enMongoDiag from "./locales/en/mongoDiag.json";
import enMongoManage from "./locales/en/mongoManage.json";
import enLicenses from "./locales/en/licenses.json";
import enWorkspace from "./locales/en/workspace.json";
import enWorkspaceNew from "./locales/en/workspaceNew.json";
import enWorkspacePicker from "./locales/en/workspacePicker.json";
import enHappy from "./locales/en/happy.json";
import enModes from "./locales/en/modes.json";
import enMcp from "./locales/en/mcp.json";
import enUpdates from "./locales/en/updates.json";
import enSlash from "./locales/en/slash.json";
import enMemory from "./locales/en/memory.json";
import enNotes from "./locales/en/notes.json";
import { compile, formatNodes, formatNumber, formatRelative, pseudoLocalize, type Params } from "./message";
import { PSEUDO_LOCALE, detectLanguage, fallbackChain, isReviewed, isRtl, isSupported, languageName } from "./languages";

export { LANGUAGES, PSEUDO_LOCALE, detectLanguage, fallbackChain, isReviewed, isRtl, isSupported, languageInfo, languageName, matchLanguage, pickerLanguages } from "./languages";
export type { Params } from "./message";

const en = { ...enPlatform, ...enShell, ...enSettings, ...enAbout, ...enComponents, ...enPanels, ...enWorkflow, ...enExtras, ...enPreview, ...enGitx, ...enAgentux, ...enProviders, ...enContract, ...enMongo, ...enMongoStudio, ...enMongoLoud, ...enMongoForm, ...enMongoDiag, ...enMongoManage, ...enLicenses, ...enWorkspace, ...enWorkspaceNew, ...enWorkspacePicker, ...enHappy, ...enModes, ...enMcp, ...enUpdates, ...enMemory, ...enNotes, ...enSlash };
export type MessageKey = keyof typeof en;
export type Locale = string;
export type Catalog = Record<string, string>;

/** Namespaces = catalog files. The checker and the extract script read this list, so a new module adds its name here. */
export const NAMESPACES = ["platform", "shell", "settings", "about", "components", "panels", "workflow", "extras", "preview", "gitx", "agentux", "providers", "contract", "mongo", "mongoStudio", "mongoLoud", "mongoForm", "mongoDiag", "mongoManage", "licenses", "workspace", "workspaceNew", "workspacePicker", "happy", "modes", "mcp", "updates", "memory", "notes", "slash"] as const;

export const LOCALE_STORAGE_KEY = "intely.locale";

/** Lazy chunks of every non-English language, keyed by path. Vite splits one chunk per file. */
const lazyCatalogs = import.meta.glob<{ default: Catalog }>(["./locales/*/*.json", "!./locales/en/*.json"]);

const catalogs = new Map<string, Catalog>([["en", en as Catalog]]);
const [version, setVersion] = createSignal(0);
const [lang, setLang] = createSignal<string>("en");

export const locale = lang;
export const parseLocale = (raw: unknown): string => (isSupported(raw) ? raw : "en");

const loading = new Map<string, Promise<void>>();

/** Loads the catalog files of one language (idempotent). Resolves also when the language has no catalog yet. */
export function loadCatalog(code: string): Promise<void> {
  if (catalogs.has(code) || code === PSEUDO_LOCALE) return Promise.resolve();
  let p = loading.get(code);
  if (!p) {
    const files = Object.entries(lazyCatalogs).filter(([path]) => path.startsWith(`./locales/${code}/`));
    p = Promise.all(files.map(([, load]) => load().then((m) => m.default)))
      .then((parts) => {
        catalogs.set(code, Object.assign({}, ...parts));
        setVersion((v) => v + 1);
      })
      .catch((err) => {
        console.warn(`[i18n] could not load ${code}`, err);
      })
      .finally(() => loading.delete(code));
    loading.set(code, p);
  }
  return p;
}

function applyDocument(code: string): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = code;
  document.documentElement.dir = isRtl(code) ? "rtl" : "ltr";
}

/**
 * Switches the language. The signal flips once the catalog is there, so the UI never shows a half-translated flash;
 * for English (always loaded) the switch is synchronous. `persist: false` is for the automatic first-run detection.
 */
export function setLocale(next: string, opts: { persist?: boolean } = {}): Promise<void> {
  const code = isSupported(next) ? next : "en";
  const commit = () => {
    setLang(code);
    applyDocument(code);
    if (opts.persist !== false) writeStored(LOCALE_STORAGE_KEY, code);
  };
  if (catalogs.has(code) || code === PSEUDO_LOCALE) {
    commit();
    return Promise.resolve();
  }
  return loadCatalog(code).then(commit);
}

const warned = new Set<string>();
function missing(key: string, why: string): void {
  if (import.meta.env?.DEV && !warned.has(key)) {
    warned.add(key);
    console.warn(`[i18n] ${why}: ${key}`);
  }
}

/** Plain lookup through the fallback chain; undefined when no catalog has the key. */
export function lookup(key: string, code: string = lang()): string | undefined {
  for (const c of fallbackChain(code)) {
    const text = catalogs.get(c)?.[key];
    if (text !== undefined) return text;
  }
  return undefined;
}

/** Formatting locale for Intl: the pseudo-locale formats like English. */
const intlLocale = (code: string) => (code === PSEUDO_LOCALE ? "en" : code);

export function translate(code: string, key: string, params?: Params): string {
  const text = lookup(key, code);
  if (text === undefined) {
    missing(key, "missing key");
    return key;
  }
  let out = text;
  if (text.includes("{") || text.includes("'")) {
    try {
      out = formatNodes(compile(text), params ?? {}, intlLocale(code));
    } catch (err) {
      missing(key, `bad message (${(err as Error).message})`);
    }
  }
  return code === PSEUDO_LOCALE ? pseudoLocalize(out) : out;
}

/** Translates `key` into the current language. Reactive: call it inside JSX, a memo or an effect. */
export function t(key: MessageKey, params?: Params): string {
  version();
  return translate(lang(), key, params);
}

/** Intl formatting in the current language (reactive like `t`). */
export const fmt = {
  number: (n: number, style?: string) => (version(), formatNumber(n, intlLocale(lang()), style)),
  date: (d: Date | number, style: "short" | "medium" | "long" | "full" = "medium") => new Intl.DateTimeFormat(intlLocale(lang()), { dateStyle: style }).format(d),
  relative: (value: Date | number, unit?: string) => formatRelative(value, intlLocale(lang()), unit),
  list: (items: string[], type: "conjunction" | "disjunction" = "conjunction") => new Intl.ListFormat(intlLocale(lang()), { type }).format(items),
};

/** Name of a language in its own language (the picker), or in the current one. */
export const nameOf = (code: string, inCurrent = false) => languageName(code, inCurrent ? intlLocale(lang()) : code);

/** True when the active language is machine translated (shows the notice in Settings > General). */
export const isMachineTranslated = () => !isReviewed(lang()) && lang() !== PSEUDO_LOCALE;

/** Resolves when the first-run language is loaded; the app waits for it so the first paint is not English. */
export const localeReady: Promise<void> = (() => {
  const stored = readStored(LOCALE_STORAGE_KEY);
  return setLocale(isSupported(stored) ? stored : detectLanguage(), { persist: false });
})();

/** Test hook: forget loaded catalogs (except English). */
export function resetCatalogsForTest(): void {
  for (const k of [...catalogs.keys()]) if (k !== "en") catalogs.delete(k);
  loading.clear();
  warned.clear();
}
