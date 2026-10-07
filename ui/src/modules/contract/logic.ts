// Pure helpers of the contract module: filters, counts, examples generated from schemas, and "copy as cURL".
import type { ClientReport, Detail, Endpoint, Finding, Kind, Report, SchemaNode, Severity, Unused } from "./types";

export const SEVERITIES: Severity[] = ["error", "warn", "info"];
export const KINDS: Kind[] = ["missing", "renamed", "method", "tagMismatch", "requiredParam", "responseField", "deprecated"];

export interface FindingFilter {
  repoId?: string;
  severity?: Severity;
  kind?: Kind;
  text?: string;
}

export function allFindings(r: Report | undefined): Finding[] {
  return (r?.clients ?? []).flatMap((c) => c.findings);
}

export function filterFindings(r: Report | undefined, f: FindingFilter): Finding[] {
  const q = f.text?.trim().toLowerCase();
  return allFindings(r).filter(
    (x) =>
      (!f.repoId || x.repoId === f.repoId) &&
      (!f.severity || x.severity === f.severity) &&
      (!f.kind || x.kind === f.kind) &&
      (!q || x.target.toLowerCase().includes(q) || x.site.file.toLowerCase().includes(q) || x.names.some((n) => n.toLowerCase().includes(q))),
  );
}

export function countBy(fs: Finding[]): Record<Severity, number> {
  const out: Record<Severity, number> = { error: 0, warn: 0, info: 0 };
  for (const f of fs) out[f.severity] += 1;
  return out;
}

export function repoCounts(c: ClientReport): { calls: number; errors: number; warnings: number } {
  return { calls: c.counts.calls, errors: c.counts.errors, warnings: c.counts.warnings };
}

/** Badge for a row of the Changes tree: the file holds API calls; the tone says how bad they look. */
export function badgeFor(r: Report | undefined, repoId: string, path: string): { calls: number; errors: number; warnings: number } | undefined {
  const row = r?.clients.find((c) => c.repoId === repoId)?.files[path];
  if (!row || row[0] === 0) return undefined;
  return { calls: row[0], errors: row[1], warnings: row[2] };
}

export function filterEndpoints(eps: Endpoint[], text: string, method: string, tag: string, limit = 300): { rows: Endpoint[]; total: number } {
  const q = text.trim().toLowerCase();
  const all = eps.filter((e) => (!method || e.method === method) && (!tag || e.tags.includes(tag)) && (!q || e.path.toLowerCase().includes(q) || (e.operationId ?? "").toLowerCase().includes(q) || e.summary.toLowerCase().includes(q) || e.tags.some((t) => t.toLowerCase().includes(q))));
  return { rows: all.slice(0, limit), total: all.length };
}

export const allTags = (eps: Endpoint[]): string[] => [...new Set(eps.flatMap((e) => e.tags))].sort((a, b) => a.localeCompare(b));
export const allMethods = (eps: Endpoint[]): string[] => [...new Set(eps.map((e) => e.method))].sort();

export function filterUnused(list: Unused[], text: string, limit = 300): { rows: Unused[]; total: number } {
  const q = text.trim().toLowerCase();
  const all = list.filter((u) => !q || u.path.toLowerCase().includes(q) || (u.operationId ?? "").toLowerCase().includes(q) || u.tags.some((t) => t.toLowerCase().includes(q)));
  return { rows: all.slice(0, limit), total: all.length };
}

/** An example value for a schema: its own example, default or first enum value, else a typed placeholder. Never real data. */
export function exampleOf(n: SchemaNode | null | undefined, depth = 0): unknown {
  if (!n) return null;
  if (n.example !== null && n.example !== undefined) return n.example;
  if (n.default !== null && n.default !== undefined) return n.default;
  if (n.enum.length) return n.enum[0];
  if (depth > 8 || n.circular) return n.type === "array" ? [] : {};
  if (n.props.length || n.type === "object") {
    if (!n.props.length && n.additional) return { key: exampleOf(n.additional, depth + 1) };
    return Object.fromEntries(n.props.map((p) => [p.name, exampleOf(p.node, depth + 1)]));
  }
  switch (n.type) {
    case "array":
      return n.items ? [exampleOf(n.items, depth + 1)] : [];
    case "integer":
      return 0;
    case "number":
      return 0;
    case "boolean":
      return true;
    case "string":
      switch (n.format) {
        case "date-time":
          return "2026-01-01T00:00:00Z";
        case "date":
          return "2026-01-01";
        case "email":
          return "user@example.com";
        case "uuid":
          return "00000000-0000-0000-0000-000000000000";
        case "password":
          return "<password>";
        default:
          return "string";
      }
    default:
      return null;
  }
}

export const prettyJson = (v: unknown): string => JSON.stringify(v, null, 2);

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** A cURL command with placeholders for everything private (token, base URL when unknown, ids). It is only text: nothing is sent. */
export function curlFor(d: Detail, host: string): string {
  const e = d.endpoint;
  const base = (host || "<BASE_URL>").replace(/\/$/, "");
  const path = e.path.replace(/\{([^}]+)\}/g, "<$1>");
  const query = d.params.filter((p) => p.in === "query" && p.required).map((p) => `${encodeURIComponent(p.name)}=<${p.name}>`);
  const url = `${base}${path}${query.length ? `?${query.join("&")}` : ""}`;
  const parts = [`curl -X ${e.method} ${shq(url)}`];
  if (d.secured) parts.push(`-H ${shq("Authorization: Bearer <TOKEN>")}`);
  for (const p of d.params.filter((x) => x.in === "header" && x.required && !/^authorization$/i.test(x.name))) parts.push(`-H ${shq(`${p.name}: <${p.name}>`)}`);
  if (d.request) {
    parts.push(`-H ${shq("Content-Type: application/json")}`);
    parts.push(`-d ${shq(JSON.stringify(exampleOf(d.request)))}`);
  }
  return parts.join(" \\\n  ");
}

export const specHost = (r: Report | undefined): string => r?.spec.host ?? "";

export function pct(n: number): number {
  return Math.round(n * 100);
}

/** `file:line` shown next to a finding. */
export const where = (f: Finding): string => `${f.site.file}:${f.site.line}`;
