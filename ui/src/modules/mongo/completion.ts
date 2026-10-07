// Schema-aware completion for the query bar. `completionsFor` is pure (text before the cursor in, options out) so it is
// tested without CodeMirror; `completionSource` adapts it. Field names and types come from the digest (P1: names and types
// only, never values), operators from a fixed table.

import { snippetCompletion, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import { t, type MessageKey } from "../../i18n";
import type { DigestField, SchemaDigest } from "./digest";

export type FieldKind = "filter" | "projection" | "sort";

export interface Item {
  label: string;
  /** Text to insert; `${}` marks the cursor stop (a snippet). */
  apply?: string;
  type: "property" | "keyword" | "function" | "constant";
  detail?: string;
  info?: string;
  boost?: number;
}

const OPERATORS: [string, MessageKey][] = [
  ["$eq", "mongo.op.eq"],
  ["$ne", "mongo.op.ne"],
  ["$gt", "mongo.op.gt"],
  ["$gte", "mongo.op.gte"],
  ["$lt", "mongo.op.lt"],
  ["$lte", "mongo.op.lte"],
  ["$in", "mongo.op.in"],
  ["$nin", "mongo.op.nin"],
  ["$exists", "mongo.op.exists"],
  ["$type", "mongo.op.type"],
  ["$regex", "mongo.op.regex"],
  ["$options", "mongo.op.options"],
  ["$size", "mongo.op.size"],
  ["$all", "mongo.op.all"],
  ["$elemMatch", "mongo.op.elemMatch"],
  ["$not", "mongo.op.not"],
  ["$mod", "mongo.op.mod"],
];
const LOGIC: [string, MessageKey][] = [
  ["$and", "mongo.op.and"],
  ["$or", "mongo.op.or"],
  ["$nor", "mongo.op.nor"],
  ["$expr", "mongo.op.expr"],
];

const VALUES = (): Item[] => [
  { label: 'ObjectId("…")', apply: 'ObjectId("${}")', type: "function", detail: "ObjectId", info: t("mongo.complete.objectId"), boost: 3 }, // i18n-ignore: code snippet
  { label: 'ISODate("…")', apply: 'ISODate("${}")', type: "function", detail: "Date", info: t("mongo.complete.isoDate"), boost: 3 }, // i18n-ignore: code snippet
  { label: "new Date()", apply: "new Date(${})", type: "function", detail: "Date", info: t("mongo.complete.newDate") }, // i18n-ignore: code snippet
  { label: 'NumberLong("…")', apply: 'NumberLong("${}")', type: "function", detail: "Int64" }, // i18n-ignore: code snippet
  { label: 'NumberDecimal("…")', apply: 'NumberDecimal("${}")', type: "function", detail: "Decimal128" }, // i18n-ignore: code snippet
  { label: "/pattern/i", apply: "/${}/i", type: "function", detail: "Regex" }, // i18n-ignore: code snippet
  { label: "true", type: "constant" },
  { label: "false", type: "constant" },
  { label: "null", type: "constant", info: t("mongo.complete.null") },
];

const typeDetail = (f: DigestField): string => {
  const first = f.types[0];
  const more = f.types.length > 1 ? ` +${f.types.length - 1}` : "";
  return `${first ? first.type : "?"}${f.array ? "[]" : ""}${more}`;
};

function fieldItems(d: SchemaDigest | undefined): Item[] {
  return (d?.fields ?? []).map((f) => ({
    label: f.path,
    type: "property" as const,
    detail: typeDetail(f),
    info: [f.enumValues ? t("mongo.complete.distinct", { n: f.enumValues }) : "", f.trap ?? "", f.sensitive ? t("mongo.complete.sensitive") : "", f.presence < 0.95 ? t("mongo.complete.presence", { pct: Math.round(f.presence * 100) }) : ""].filter(Boolean).join(". ") || undefined,
    boost: f.presence * 2 - (f.path.includes(".") ? 0.5 : 0),
  }));
}

/** Completions for the text before the cursor. `from` is an offset into `before`. */
export function completionsFor(d: SchemaDigest | undefined, kind: FieldKind, before: string, explicit = false): { from: number; options: Item[] } | null {
  const word = /[\w$.]*$/.exec(before)![0];
  const from = before.length - word.length;
  const prev = before.slice(0, from).trimEnd();
  const last = prev.slice(-1);
  if (!word && !explicit && last !== ":") return null;
  if (word.startsWith("$")) {
    if (kind !== "filter") return null;
    const list = [...OPERATORS, ...(last === "{" || last === "," || prev === "" ? LOGIC : [])];
    return { from, options: list.filter(([n]) => n.startsWith(word)).map(([label, info]) => ({ label, type: "keyword", info: t(info), boost: 0 })) };
  }
  if (last === ":") {
    if (kind === "sort") return { from, options: [{ label: "1", type: "constant", info: t("mongo.complete.asc") }, { label: "-1", type: "constant", info: t("mongo.complete.desc") }] };
    if (kind === "projection") return { from, options: [{ label: "1", type: "constant", info: t("mongo.complete.include") }, { label: "0", type: "constant", info: t("mongo.complete.exclude") }] };
    const key = /([\w$.]+)["']?\s*:$/.exec(prev)?.[1];
    const field = key ? d?.fields.find((f) => f.path === key) : undefined;
    const ftype = field?.types[0]?.type;
    const boosted = VALUES().map((v) => ({ ...v, boost: (v.boost ?? 0) + ((ftype === "ObjectId" && v.label.startsWith("ObjectId")) || (ftype === "Date" && v.label.startsWith("ISODate")) ? 5 : 0) }));
    const all: Item[] = [...boosted, { label: "{ $", apply: "{ $${} }", type: "keyword" as const, info: t("mongo.complete.opExpr") }];
    return { from, options: all.filter((o) => !word || o.label.toLowerCase().startsWith(word.toLowerCase())).sort((a, b) => (b.boost ?? 0) - (a.boost ?? 0)) };
  }
  if (last === "{" || last === "," || prev === "" || last === "[") {
    const fields = fieldItems(d).filter((o) => !word || o.label.toLowerCase().startsWith(word.toLowerCase()));
    const logic: Item[] = kind === "filter" ? LOGIC.filter(([n]) => !word || n.startsWith(word)).map(([label, info]) => ({ label, type: "keyword" as const, info: t(info), boost: -1 })) : [];
    return { from, options: [...fields, ...logic] };
  }
  return null;
}

const toCompletion = (i: Item): Completion => {
  const base: Completion = { label: i.label, type: i.type, detail: i.detail, info: i.info, boost: i.boost };
  return i.apply?.includes("${}") ? snippetCompletion(i.apply, base) : i.apply ? { ...base, apply: i.apply } : base;
};

export function completionSource(getDigest: () => SchemaDigest | undefined, kind: FieldKind): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const r = completionsFor(getDigest(), kind, ctx.state.sliceDoc(0, ctx.pos), ctx.explicit);
    if (!r || !r.options.length) return null;
    return { from: r.from, options: r.options.map(toCompletion), validFor: /^[\w$.]*$/ };
  };
}
