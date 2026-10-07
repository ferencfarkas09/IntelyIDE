// A schema digest built in the webview from a sample of documents (the `sample` command): field paths, type histogram,
// presence, array flag, enum-like and trap hints. Only names, types and shares are kept, never the values (an enum-like
// field keeps the number of distinct values). It feeds completion and the grid's masking; what an AI model sees is decided
// in Rust (`crates/mongo/src/ai`), not here.

import { isScalarObject, typeOf, type Doc, type Json } from "./ejson";
import { generic } from "./presets/generic";

export interface DigestField {
  path: string;
  /** Types seen with their share (0..100) of the documents that have the field, largest first. */
  types: { type: string; pct: number }[];
  /** Share of sampled documents that have the path (0..1). */
  presence: number;
  array: boolean;
  /** 2 to 8 distinct short strings in 100 or more samples: only the count is kept. */
  enumValues?: number;
  /** Deterministic warning, e.g. "TRAP 4% strings". */
  trap?: string;
  /** Matches the PII list: masked in the grid until revealed. */
  sensitive?: boolean;
}

export interface DigestIndex {
  name: string;
  key: Record<string, number | string>;
}

export interface SchemaDigest {
  sampled: number;
  fields: DigestField[];
  indexes: DigestIndex[];
  /** Tenant field by convention. */
  tenantField?: string;
}

// Hungarian stems with and without accents, plus the English words ((design notes: mongo-studio-plan) 2.2). Short stems must be a
// whole word of the path (camelCase and separators split it), long stems may sit inside a word (`szamlaSorszam`).
const SHORT = new Set(["name", "nev", "tel", "cim", "pin", "key", "hash", "tax", "pwd", "iban"]);
const LONG = ["email", "telefon", "lakcim", "szuletes", "birth", "anyja", "adoszam", "szamla", "jelszo", "titok", "password", "secret", "token", "address", "phone", "street", "taxnumber", "apikey", "credential"];

export function isSensitiveName(path: string): boolean {
  const plain = path.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const words = plain.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((w) => SHORT.has(w) || LONG.some((l) => w.includes(l)) || w.endsWith("nev") || w.endsWith("name"));
}


interface Acc {
  types: Map<string, number>;
  seen: number;
  array: boolean;
  strings: Set<string>;
  overflow: boolean;
}

const MAX_DEPTH = 4;
const MAX_FIELDS = 80;

/** `tenantCandidates` come from the profile's preset (presets/index.ts); the default is the Generic list. */
export function buildDigest(docs: readonly Doc[], indexes: DigestIndex[] = [], tenantCandidates: readonly string[] = generic.tenantCandidates): SchemaDigest {
  const acc = new Map<string, Acc>();
  const touch = (path: string, v: Json | undefined, perDoc: Set<string>) => {
    const t = typeOf(v);
    const e = acc.get(path) ?? { types: new Map(), seen: 0, array: false, strings: new Set(), overflow: false };
    e.types.set(t, (e.types.get(t) ?? 0) + 1);
    if (!perDoc.has(path)) (e.seen++, perDoc.add(path));
    if (typeof v === "string") {
      if (e.strings.size < 16 && v.length <= 32) e.strings.add(v);
      else e.overflow = true;
    }
    acc.set(path, e);
  };
  const visit = (prefix: string, v: Json | undefined, depth: number, perDoc: Set<string>) => {
    touch(prefix, v, perDoc);
    if (depth >= MAX_DEPTH || v === null || typeof v !== "object" || isScalarObject(v)) return;
    if (Array.isArray(v)) {
      acc.get(prefix)!.array = true;
      for (const x of v) if (x && typeof x === "object" && !Array.isArray(x) && !isScalarObject(x)) for (const [k, sv] of Object.entries(x)) visit(`${prefix}.${k}`, sv, depth + 1, perDoc);
      return;
    }
    for (const [k, sv] of Object.entries(v)) visit(`${prefix}.${k}`, sv, depth + 1, perDoc);
  };
  for (const d of docs) {
    const perDoc = new Set<string>();
    for (const [k, v] of Object.entries(d)) visit(k, v, 1, perDoc);
  }
  const n = Math.max(docs.length, 1);
  const fields: DigestField[] = [...acc.entries()].map(([path, e]) => {
    const total = [...e.types.values()].reduce((a, b) => a + b, 0);
    const types = [...e.types.entries()].map(([type, c]) => ({ type, pct: Math.round((c / total) * 1000) / 10 })).sort((a, b) => b.pct - a.pct);
    const strPct = types.find((t) => t.type === "String")?.pct ?? 0;
    const numeric = types.some((t) => ["Int32", "Int64", "Double", "Decimal128"].includes(t.type));
    const dateLike = strPct > 0 && strPct < 50 && types.some((t) => t.type === "Date");
    const onlyStrings = types.length === 1 && types[0].type === "String";
    return {
      path,
      types,
      presence: Math.round((e.seen / n) * 100) / 100,
      array: e.array,
      enumValues: onlyStrings && !e.overflow && e.strings.size >= 2 && e.strings.size <= 8 && e.seen >= 100 && !/(id|sku|name|email|phone|note)$/i.test(path) ? e.strings.size : undefined,
      trap: (numeric || dateLike) && strPct > 0 && strPct < 50 ? `TRAP ${strPct}% strings` : undefined,
      sensitive: isSensitiveName(path) || undefined,
    };
  });
  fields.sort((a, b) => b.presence - a.presence || a.path.split(".").length - b.path.split(".").length || a.path.localeCompare(b.path));
  const top = fields.slice(0, MAX_FIELDS);
  return { sampled: docs.length, fields: top, indexes, tenantField: tenantCandidates.find((c) => top.some((f) => f.path === c)) };
}
