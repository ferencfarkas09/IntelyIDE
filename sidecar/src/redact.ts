// Redaction for events, logs and errors (providers-plan 4.2): tokens, Authorization headers, key=value secrets.
const PATTERNS: [RegExp, string][] = [
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, '<redacted:key>'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '<redacted:key>'],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g, '<redacted:token>'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '<redacted:key>'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '<redacted:token>'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<redacted:jwt>'],
  [/(Authorization\s*[:=]\s*)(?:(?:Bearer|Basic|Token|Digest)\s+)?\S+/gi, '$1<redacted>'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g, 'Bearer <redacted>'],
  [/-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,30}PRIVATE KEY-----|$)/g, '<redacted:private-key>'],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}|\bwhsec_[A-Za-z0-9]{8,}/g, '<redacted:key>'],
  // user:password@ and DSN-style key@ in any URL
  [/(\b[A-Za-z][A-Za-z0-9+.-]{1,20}:\/\/)[^\s/@:]{1,200}(?::[^\s/@]{0,200})?@/g, '$1<redacted>@'],
  // secret-looking names, env style or JSON style; a short value is only taken after an `=`
  [/((?:api[_-]?key|private[_-]?key|access[_-]?key|passphrase|credential|password|passwd|secret|token|dsn|_auth)[A-Za-z0-9_.-]{0,40}["']?\s*[=:]\s*)(['"]?)[^\s'"&,}]{6,}\2/gi, '$1<redacted>'],
  [/((?:api[_-]?key|private[_-]?key|access[_-]?key|passphrase|credential|password|passwd|secret|token|dsn|_auth)[A-Za-z0-9_.-]{0,40}["']\s*:\s*)(["'])[^"'\n]+\2/gi, '$1<redacted>'],
  [/((?:api[_-]?key|private[_-]?key|access[_-]?key|passphrase|credential|password|passwd|secret|token|dsn|_auth)[A-Za-z0-9_.-]{0,40}["']?\s*=\s*)(['"]?)[^\s'"&,}]{1,5}\2(?=[\s'"&,}]|$)/gi, '$1<redacted>'],
];

// ---- exact values (MCP spec 5.5) ----------------------------------------------------------------------------------------------------
// The patterns above only know the SHAPE of a secret. An MCP server's environment and header values are plain strings the IDE knows exactly,
// so a session registers them and redact() replaces them (and the forms a server echoes them in) before the patterns run.

const MASK = '<redacted>';
const MIN_SECRET = 4;
const MAX_FORMS = 8;

/** The text inside JSON.stringify(value), without the quotes. */
const jsonEscaped = (v: string): string => JSON.stringify(v).slice(1, -1);

/** Percent-encoding with the RFC 3986 unreserved set (what the Rust twin does; encodeURIComponent also leaves !'()* alone). */
const percentEncode = (v: string): string =>
  [...Buffer.from(v, 'utf8')].map((b) => (/[A-Za-z0-9\-._~]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`)).join('');

/**
 * A secret value and the forms an error message is likely to echo it in, deduplicated, each of 4 or more characters, at most 8 in all (the
 * value first): the bare token of a `Bearer`/`Basic`/`Token` header value, for `Basic` the base64 part and the decoded `user:password`, and
 * for every value its JSON-escaped, percent-encoded, standard base64 and URL-safe base64 form. The Rust twin is `derive_forms`
 * (crates/mcp/src/scrub.rs); both read packages/protocol/fixtures/mcp-secret-forms.json.
 */
export function deriveForms(value: string): string[] {
  const forms = [value];
  const scheme = /^(bearer|basic|token) /i.exec(value);
  if (scheme) {
    const rest = value.slice(scheme[0].length).trim();
    forms.push(rest);
    if (scheme[1].toLowerCase() === 'basic' && /^[A-Za-z0-9+/_-]+=*$/.test(rest)) {
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(rest, 'base64'));
        if (decoded.includes(':')) forms.push(decoded);
      } catch { /* not valid UTF-8: not a user:password pair */ }
    }
  }
  forms.push(jsonEscaped(value), percentEncode(value), Buffer.from(value, 'utf8').toString('base64'), Buffer.from(value, 'utf8').toString('base64url'));
  const out: string[] = [];
  for (const f of forms) if (f.length >= MIN_SECRET && !out.includes(f) && out.length < MAX_FORMS) out.push(f);
  return out;
}

const registered = new Map<string, number>();
let exactForms: string[] = [];
let exactShort: string[] = [];

const rebuild = (): void => {
  exactForms = [...registered.keys()].filter((v) => v.length >= MIN_SECRET).sort((a, b) => b.length - a.length);
  exactShort = [...registered.keys()].filter((v) => v.length < MIN_SECRET);
};

/**
 * Registers secret values (and their derived forms): from then on redact() replaces them by `<redacted>`, whatever the patterns say. A value
 * under 4 characters only matches when the whole text equals it. Returns the disposer (a value registered by two sessions stays until both
 * dispose; calling it twice is harmless).
 */
export function registerSecrets(values: readonly string[]): () => void {
  const mine: string[] = [];
  for (const v of values) {
    if (!v) continue;
    for (const f of v.length >= MIN_SECRET ? deriveForms(v) : [v]) if (!mine.includes(f)) mine.push(f);
  }
  for (const f of mine) registered.set(f, (registered.get(f) ?? 0) + 1);
  rebuild();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const f of mine) {
      const n = (registered.get(f) ?? 1) - 1;
      if (n <= 0) registered.delete(f);
      else registered.set(f, n);
    }
    rebuild();
  };
}

export function redact(text: string): string {
  let out = text;
  if (exactShort.length > 0 && exactShort.includes(out)) return MASK;
  for (const f of exactForms) if (out.includes(f)) out = out.split(f).join(MASK);
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  return out;
}

/** Redacts every string inside a JSON-like value (depth-limited, never mutates the input). */
export function redactDeep<T>(v: T, depth = 8): T {
  if (typeof v === 'string') return redact(v) as T;
  if (depth <= 0 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, depth - 1)) as T;
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) o[k] = redactDeep(x, depth - 1);
  return o as T;
}

export function truncate(text: string, max = 8000): string {
  return text.length > max ? `${text.slice(0, max)}\n... [${text.length - max} more chars]` : text;
}
