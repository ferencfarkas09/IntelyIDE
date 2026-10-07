/** Languages the app ships. `reviewed` = a human checked the whole catalog; everything else is machine translated. */
export interface LanguageInfo {
  code: string;
  reviewed?: boolean;
  rtl?: boolean;
  /** Only offered in development builds (overflow testing). */
  pseudo?: boolean;
  /** Regex of the script the strings are expected to be written in (the catalog checker uses it). */
  script?: string;
}

const L = (code: string, extra: Omit<LanguageInfo, "code"> = {}): LanguageInfo => ({ code, ...extra });

export const PSEUDO_LOCALE = "en-XA";

export const LANGUAGES: readonly LanguageInfo[] = [
  L("en", { reviewed: true }),
  L("hu", { reviewed: true }),
  L("de"), L("fr"), L("es"), L("it"), L("pt-PT"), L("pt-BR"), L("nl"), L("pl"), L("cs"), L("sk"), L("ro"),
  L("bg", { script: "Cyrillic" }), L("hr"), L("sr", { script: "Cyrillic" }), L("sl"), L("uk", { script: "Cyrillic" }), L("ru", { script: "Cyrillic" }),
  L("tr"), L("el", { script: "Greek" }), L("sv"), L("da"), L("nb"), L("fi"), L("is"), L("et"), L("lv"), L("lt"), L("sq"),
  L("mk", { script: "Cyrillic" }), L("bs"), L("ca"),
  L("ar", { rtl: true, script: "Arabic" }), L("he", { rtl: true, script: "Hebrew" }), L("fa", { rtl: true, script: "Arabic" }), L("ur", { rtl: true, script: "Arabic" }),
  L("hi", { script: "Devanagari" }), L("bn", { script: "Bengali" }), L("ta", { script: "Tamil" }), L("te", { script: "Telugu" }), L("mr", { script: "Devanagari" }),
  L("th", { script: "Thai" }), L("vi"), L("id"), L("ms"), L("fil"),
  L("zh-Hans", { script: "Han" }), L("zh-Hant", { script: "Han" }), L("ja", { script: "Han" }), L("ko", { script: "Hangul" }),
  L("sw"), L("af"),
  L(PSEUDO_LOCALE, { pseudo: true }),
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

export const languageInfo = (code: string): LanguageInfo | undefined => BY_CODE.get(code);
export const isSupported = (code: unknown): code is string => typeof code === "string" && BY_CODE.has(code);
export const isRtl = (code: string): boolean => !!BY_CODE.get(code)?.rtl;
export const isReviewed = (code: string): boolean => !!BY_CODE.get(code)?.reviewed;

/** Languages the picker offers: the pseudo-locale only in development. */
export const pickerLanguages = (): LanguageInfo[] => LANGUAGES.filter((l) => !l.pseudo || import.meta.env?.DEV);

/** lang-region -> lang -> en. `zh-Hans-CN` tries `zh-Hans`, then `zh`, then English. */
export function fallbackChain(code: string): string[] {
  const chain: string[] = [];
  const parts = code.split("-");
  for (let n = parts.length; n >= 1; n--) chain.push(parts.slice(0, n).join("-"));
  if (!chain.includes("en")) chain.push("en");
  return chain;
}

/** Folds a BCP-47 tag from the browser onto one of the shipped languages, or null. */
export function matchLanguage(tag: string): string | null {
  const t = tag.replace(/_/g, "-");
  if (isSupported(t) && t !== PSEUDO_LOCALE) return t;
  const [lang, ...rest] = t.split("-");
  const l = lang.toLowerCase();
  const region = rest.find((r) => /^[A-Za-z]{2}$|^\d{3}$/.test(r))?.toUpperCase();
  const script = rest.find((r) => /^[A-Za-z]{4}$/.test(r));
  if (l === "zh") return script?.toLowerCase() === "hant" || region === "TW" || region === "HK" || region === "MO" ? "zh-Hant" : "zh-Hans";
  if (l === "pt") return region && region !== "BR" ? "pt-PT" : "pt-BR";
  const alias: Record<string, string> = { no: "nb", nn: "nb", iw: "he", in: "id", tl: "fil", sh: "hr" };
  const folded = alias[l] ?? l;
  return isSupported(folded) && folded !== PSEUDO_LOCALE ? folded : null;
}

/** First run: the first browser language we ship, else English. */
export function detectLanguage(preferred: readonly string[] = typeof navigator === "undefined" ? [] : (navigator.languages?.length ? navigator.languages : [navigator.language])): string {
  for (const tag of preferred) {
    const m = tag ? matchLanguage(tag) : null;
    if (m) return m;
  }
  return "en";
}

/** The language's own name (Intl.DisplayNames in that language), with a fixed table where the Intl result is too vague. */
const OWN_NAMES: Record<string, string> = { "zh-Hans": "简体中文", "zh-Hant": "繁體中文", "pt-PT": "Português (Portugal)", "pt-BR": "Português (Brasil)", sr: "Српски", fil: "Filipino", [PSEUDO_LOCALE]: "Pseudo (en-XA)" };
export function languageName(code: string, inLocale: string = code): string {
  if (inLocale === code && OWN_NAMES[code]) return OWN_NAMES[code];
  try {
    const name = new Intl.DisplayNames([inLocale], { type: "language" }).of(code);
    if (name && name !== code) return name.charAt(0).toLocaleUpperCase(inLocale) + name.slice(1);
  } catch {
    /* Intl.DisplayNames missing or the tag is unknown */
  }
  return OWN_NAMES[code] ?? code;
}
