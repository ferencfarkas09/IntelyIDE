import { ABOUT } from "../aboutText";

/*
 * The public documentation URLs of the Welcome screen live here and nowhere else (decision D9). Until dedicated pages exist
 * they point at the GitHub project that About already shows and at the in-repo safety document. Always https.
 */
const BASE = ABOUT.source ?? ABOUT.github.company;

export const DOCS_URL = BASE;
export const SAFETY_URL = `${BASE}/blob/main/docs/safety.md`;

/** The only schemes the Welcome links may use. */
export const isHttps = (url: string): boolean => url.startsWith("https://");
