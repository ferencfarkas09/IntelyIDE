// Canonical Extended JSON, as it arrives from Rust: every number and date is a typed wrapper (Int64 stays a string, so it
// never becomes a JS number). Pure helpers for the grid, the trees and the copy actions.
import { fmt } from "../../i18n";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Doc = { [k: string]: Json };

export type BsonType =
  | "ObjectId" | "Date" | "String" | "Int32" | "Int64" | "Double" | "Decimal128" | "Boolean" | "Null" | "Array" | "Object"
  | "Binary" | "UUID" | "Regex" | "Timestamp" | "MinKey" | "MaxKey" | "Undefined" | "Symbol" | "Code" | "DBPointer";

const isObj = (v: unknown): v is { [k: string]: Json } => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseDoc(text: string): Doc {
  const v = JSON.parse(text) as Json;
  if (!isObj(v)) throw new Error("A document must be an object");
  return v;
}

/** The single `$`-key of a wrapper object, or undefined for an ordinary sub-document. */
function wrapperKey(v: { [k: string]: Json }): string | undefined {
  const keys = Object.keys(v);
  const k = keys[0];
  if (!k || !k.startsWith("$")) return undefined;
  if (keys.length === 1) return ["$oid", "$date", "$numberInt", "$numberLong", "$numberDouble", "$numberDecimal", "$regularExpression", "$timestamp", "$minKey", "$maxKey", "$undefined", "$symbol", "$binary", "$uuid", "$code", "$dbPointer"].includes(k) ? k : undefined;
  if (k === "$binary" || k === "$code") return k;
  return undefined;
}

/** True for wrapper objects (they render as one value, not as a nested document). */
export const isScalarObject = (v: unknown): boolean => isObj(v) && wrapperKey(v) !== undefined;

export function typeOf(v: Json | undefined): BsonType {
  if (v === null || v === undefined) return "Null";
  if (typeof v === "string") return "String";
  if (typeof v === "boolean") return "Boolean";
  if (typeof v === "number") return Number.isInteger(v) ? "Int32" : "Double";
  if (Array.isArray(v)) return "Array";
  switch (wrapperKey(v)) {
    case "$oid": return "ObjectId";
    case "$date": return "Date";
    case "$numberInt": return "Int32";
    case "$numberLong": return "Int64";
    case "$numberDouble": return "Double";
    case "$numberDecimal": return "Decimal128";
    case "$regularExpression": return "Regex";
    case "$timestamp": return "Timestamp";
    case "$minKey": return "MinKey";
    case "$maxKey": return "MaxKey";
    case "$undefined": return "Undefined";
    case "$symbol": return "Symbol";
    case "$binary": return (v as { $binary?: { subType?: string } }).$binary?.subType === "04" ? "UUID" : "Binary";
    case "$uuid": return "UUID";
    case "$code": return "Code";
    case "$dbPointer": return "DBPointer";
    default: return "Object";
  }
}

export function dateMs(v: Json | undefined): number | undefined {
  if (!isObj(v)) return undefined;
  const d = v.$date;
  if (typeof d === "string") return Date.parse(d);
  if (typeof d === "number") return d;
  if (isObj(d) && typeof d.$numberLong === "string") return Number(d.$numberLong);
  return undefined;
}

export function isoOf(ms: number): string {
  return Number.isFinite(ms) && Math.abs(ms) < 8.64e15 ? new Date(ms).toISOString() : "Invalid Date";
}

/** The first four bytes of an ObjectId are a big-endian Unix time in seconds. */
export function objectIdTime(hex: string): Date | undefined {
  if (!/^[0-9a-fA-F]{24}$/.test(hex)) return undefined;
  return new Date(parseInt(hex.slice(0, 8), 16) * 1000);
}

/** "5 days ago" / "in 3 hours" in the language of the UI (Intl, so the order and the plural forms are the language's own). */
export function relativeTime(ms: number, now: number = Date.now()): string {
  const diff = now - ms;
  const abs = Math.abs(diff);
  const units: [number, Intl.RelativeTimeFormatUnit][] = [[31536000000, "year"], [2592000000, "month"], [86400000, "day"], [3600000, "hour"], [60000, "minute"]];
  for (const [size, unit] of units) {
    if (abs >= size) {
      const n = Math.floor(abs / size);
      return fmt.relative(diff >= 0 ? -n : n, unit);
    }
  }
  return fmt.relative(0, "second");
}

export const CELL_MAX = 160;
export const VALUE_MAX = 1024;

/** Text of a scalar for a grid cell or a tree leaf (no quotes around strings; the renderer adds styling). */
export function scalarText(v: Json | undefined): string {
  if (v === undefined) return "";
  if (v === null) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return `[${v.length}]`;
  const t = typeOf(v);
  const w = v as Record<string, Json>;
  switch (t) {
    case "ObjectId": return String(w.$oid);
    case "Date": { const ms = dateMs(v); return ms === undefined ? "Invalid Date" : isoOf(ms); }
    case "Int32": return String(w.$numberInt);
    case "Int64": return String(w.$numberLong);
    case "Double": return String(w.$numberDouble);
    case "Decimal128": return String(w.$numberDecimal);
    case "Regex": { const r = w.$regularExpression as { pattern?: string; options?: string }; return `/${r?.pattern ?? ""}/${r?.options ?? ""}`; }
    case "Timestamp": { const ts = w.$timestamp as { t?: number; i?: number }; return `Timestamp(${ts?.t ?? 0}, ${ts?.i ?? 0})`; }
    case "MinKey": return "MinKey";
    case "MaxKey": return "MaxKey";
    case "UUID": return typeof w.$uuid === "string" ? w.$uuid : "UUID";
    case "Binary": return "BinData";
    case "Symbol": return String(w.$symbol);
    case "Code": return String(w.$code);
    case "Undefined": return "undefined";
    case "DBPointer": return "DBPointer";
    default: return `{…} ${Object.keys(v).length} fields`;
  }
}

/** Grid cell text: ObjectIds show 8 hex characters, long strings are cut. */
export function cellText(v: Json | undefined): string {
  const t = typeOf(v);
  if (v === undefined) return "";
  if (t === "ObjectId") return scalarText(v).slice(0, 8);
  if (t === "Object") return `{…} ${Object.keys(v as object).length}`;
  const s = scalarText(v);
  return s.length > CELL_MAX ? `${s.slice(0, CELL_MAX)}…` : s;
}

export function truncateValue(s: string, max: number = VALUE_MAX): { text: string; cut: boolean } {
  return s.length > max ? { text: s.slice(0, max), cut: true } : { text: s, cut: false };
}

/** mongosh syntax of one value, e.g. `ObjectId("5f…")`, `ISODate("2026-…")`, `NumberLong("9007199254740993")`. */
export function shellOf(v: Json | undefined, indent = 0, step = 2): string {
  const pad = (n: number) => " ".repeat(n);
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    return `[\n${v.map((x) => pad(indent + step) + shellOf(x, indent + step, step)).join(",\n")}\n${pad(indent)}]`;
  }
  const w = v as Record<string, Json>;
  switch (typeOf(v)) {
    case "ObjectId": return `ObjectId(${JSON.stringify(w.$oid)})`;
    case "Date": return `ISODate(${JSON.stringify(scalarText(v))})`;
    case "Int32": return `Int32(${scalarText(v)})`;
    case "Int64": return `NumberLong(${JSON.stringify(scalarText(v))})`;
    case "Double": return scalarText(v);
    case "Decimal128": return `NumberDecimal(${JSON.stringify(scalarText(v))})`;
    case "Regex": return scalarText(v);
    case "Timestamp": return scalarText(v);
    case "MinKey": return "MinKey()";
    case "MaxKey": return "MaxKey()";
    case "UUID": return `UUID(${JSON.stringify(scalarText(v))})`;
    case "Binary": case "Symbol": case "Code": case "Undefined": case "DBPointer": return JSON.stringify(v);
    default: {
      const keys = Object.keys(v);
      if (!keys.length) return "{}";
      const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
      return `{\n${keys.map((k) => `${pad(indent + step)}${key(k)}: ${shellOf((v as Doc)[k], indent + step, step)}`).join(",\n")}\n${pad(indent)}}`;
    }
  }
}

export const ejsonOf = (v: Json | undefined): string => JSON.stringify(v, null, 2) ?? "";

export interface CopyForm {
  id: "value" | "shell" | "iso" | "ejson";
  label: string;
  text: string;
}

/** The ways a value can be copied: the shown value always, plus the typed forms that exist for it. */
export function copyForms(v: Json | undefined): CopyForm[] {
  const t = typeOf(v);
  const forms: CopyForm[] = [{ id: "value", label: "Value", text: scalarText(v) }];
  if (t === "ObjectId") forms.push({ id: "shell", label: `ObjectId("…")`, text: shellOf(v) });
  if (t === "Date") forms.push({ id: "shell", label: `ISODate("…")`, text: shellOf(v) });
  if (t === "Int64" || t === "Decimal128") forms.push({ id: "shell", label: "Shell literal", text: shellOf(v) });
  forms.push({ id: "ejson", label: "Extended JSON", text: JSON.stringify(v) ?? "" });
  return forms;
}

export function getPath(doc: Doc, path: string): Json | undefined {
  let cur: Json | undefined = doc;
  for (const part of path.split(".")) {
    if (Array.isArray(cur)) cur = /^\d+$/.test(part) ? cur[Number(part)] : undefined;
    else if (isObj(cur) && !isScalarObject(cur) && part in cur) cur = cur[part];
    else return undefined;
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** Column ids for the grid: `_id` first, then the top-level keys by how many of the first documents have them. */
export function inferColumns(docs: readonly Doc[], sample = 100): string[] {
  const counts = new Map<string, number>();
  for (const d of docs.slice(0, sample)) for (const k of Object.keys(d)) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => (a[0] === "_id" ? -1 : b[0] === "_id" ? 1 : b[1] - a[1])).map(([k]) => k);
}

/** Display type chip colour class: the kit maps these to tokens. */
export type TypeTone = "accent" | "info" | "ok" | "warn" | "neutral" | "danger";
export function typeTone(t: string): TypeTone {
  switch (t) {
    case "ObjectId": return "accent";
    case "Date": case "Timestamp": return "info";
    case "Int32": case "Int64": case "Double": case "Decimal128": case "number": return "ok";
    case "Boolean": return "warn";
    default: return "neutral";
  }
}

export const MASK = "••••••••";

/** A copy of the document with every value whose path `masked` accepts replaced by dots (credential and personal fields). */
export function maskDoc(doc: Doc, masked: (path: readonly string[]) => boolean): Doc {
  const walk = (v: Json, path: string[]): Json => {
    if (path.length && masked(path)) return MASK;
    if (v === null || typeof v !== "object" || isScalarObject(v)) return v;
    if (Array.isArray(v)) return v.map((x, i) => walk(x, [...path, String(i)]));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, [...path, k])]));
  };
  return walk(doc, []) as Doc;
}
