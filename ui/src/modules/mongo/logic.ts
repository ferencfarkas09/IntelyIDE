// Pure helpers of the studio UI (no Solid, no IPC): easy to test, shared by the components and the model.
import type { ConnectionView, ConnSpec, EffectiveLevel, Environment, ProfileView, RoleChip } from "../../ipc/mongo";
import type { FieldProblem } from "../../bindings/mongo";
import { fmt, t } from "../../i18n";
import type { DigestField, SchemaDigest } from "./digest";
import { generic } from "./presets/generic";

/** Getters, so the labels follow the language wherever they are read (`sandbox` is shown as "Test"). */
export const ENV_LABEL: Record<Environment, string> = {
  get local() { return t("mongo.env.local"); },
  get sandbox() { return t("mongo.env.sandbox"); },
  get production() { return t("mongo.env.production"); },
};

/** `effective = max(tag, host rule)`: a non-loopback host is production-level whatever the tag says. */
export const isDangerous = (p: Pick<ProfileView, "environment" | "effectiveLevel">): boolean => p.environment === "production" || p.effectiveLevel === "productionLevel";

/** The environment pill shows the effective level: a non-loopback host reads Production whatever the tag says. */
export const shownEnv = (p: Pick<ProfileView, "environment" | "effectiveLevel">): ProfileView["environment"] => (isDangerous(p) ? "production" : p.environment);

export function levelNote(p: Pick<ProfileView, "environment" | "effectiveLevel" | "levelOverride">): string | undefined {
  if (p.effectiveLevel !== "productionLevel") return p.levelOverride ? t("mongo.level.loweredByYou") : undefined;
  return p.environment === "production" ? undefined : t("mongo.level.nonLoopback");
}

export interface RoleView {
  tone: "ok" | "warn" | "neutral";
  label: string;
  detail: string;
}

/** The connection chip of the role probe: always shown, and always says that read-only in the IDE is a second line of defence. */
export function roleView(role: RoleChip | undefined): RoleView {
  if (!role) return { tone: "neutral", label: t("mongo.role.none.label"), detail: t("mongo.role.none.detail") };
  switch (role.role) {
    case "readOnly":
      return { tone: "ok", label: t("mongo.role.readOnly.label"), detail: t("mongo.role.readOnly.detail") };
    case "canWrite":
      return role.noAuth
        ? { tone: "warn", label: t("mongo.role.noAuth.label"), detail: t("mongo.role.noAuth.detail") }
        : { tone: "warn", label: t("mongo.role.canWrite.label"), detail: t("mongo.role.canWrite.detail", { actions: role.actions.slice(0, 6).join(", ") }) };
    default:
      return { tone: "neutral", label: t("mongo.role.unknown.label"), detail: t("mongo.role.unknown.detail", { reason: role.reason }) };
  }
}

/** The command shown in the onboarding block. It is text to copy: the IDE never runs it and it contains no password. */
export function readOnlyUserCommand(db: string, user = "intely_readonly"): string {
  return `db.getSiblingDB("admin").createUser({\n  user: ${JSON.stringify(user || "intely_readonly")},\n  pwd: passwordPrompt(),\n  roles: [{ role: "read", db: ${JSON.stringify(db || "your_database")} }],\n})`;
}

export function testSummary(i: ConnectionView): string {
  const topo = i.topology === "replicaSet" ? t("mongo.topology.replicaSet") : i.topology === "sharded" ? t("mongo.topology.sharded") : i.topology === "standalone" ? t("mongo.topology.standalone") : t("mongo.topology.unknown");
  const access = i.role.role === "readOnly" ? t("mongo.access.read") : i.role.role === "canWrite" ? t("mongo.access.write") : t("mongo.access.unknown");
  return t("mongo.test.summary", { ms: i.pingMs, version: i.serverVersion, topology: topo, access });
}

/** Short titles per error class (the long text per diagnosis code lives in `mongoDiag`). Getters: they follow the language. */
export const ERROR_TITLES: Record<string, string> = {
  get auth() { return t("mongo.error.auth"); },
  get authz() { return t("mongo.error.authz"); },
  get dns() { return t("mongo.error.dns"); },
  get tls() { return t("mongo.error.tls"); },
  get timeout() { return t("mongo.error.timeout"); },
  get network() { return t("mongo.error.network"); },
  get tunnel() { return t("mongo.error.tunnel"); },
  get config() { return t("mongo.error.config"); },
  get selection() { return t("mongo.error.selection"); },
  get other() { return t("mongo.error.other"); },
  get parse() { return t("mongo.error.parse"); },
  get disabled() { return t("mongo.error.disabled"); },
};

/** The count in the language's own digit grouping; "~" while it is an estimate. */
export const formatCount = (n: number, exact = true): string => `${exact ? "" : "~"}${fmt.number(n)}`;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) (v /= 1024, i++);
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export function pageRange(skip: number, page: number, size: number, shown: number): string {
  if (shown === 0) return "0";
  const from = skip + page * size + 1;
  return `${fmt.number(from)}–${fmt.number(from + shown - 1)}`;
}

/** Footer text of the grid: the range on screen, of the (applied) total when known; "+" while more pages may follow. */
export function rangeLabel(page: number, size: number, shown: number, total: { value: number; exact: boolean } | undefined, hasMore: boolean): string {
  const from = pageRange(0, page, size, shown);
  if (total) return t("mongo.range.of", { range: from, total: formatCount(total.value, total.exact) });
  return shown ? `${from}${hasMore ? "+" : ""}` : "0";
}

/** Total shown in the footer: the server count minus the user's skip, capped by the user's limit. */
export function effectiveTotal(total: number, skip: number, limit: number): number {
  const rest = Math.max(0, total - skip);
  return limit > 0 ? Math.min(rest, limit) : rest;
}

export function parseIntField(text: string): number {
  const n = Number.parseInt(text.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Skip and limit of one window of the result. Returns null when the page lies past a user limit. */
export function windowFor(page: number, size: number, userSkip: number, userLimit: number): { skip: number; limit: number } | null {
  const offset = page * size;
  if (userLimit > 0 && offset >= userLimit) return null;
  return { skip: userSkip + offset, limit: userLimit > 0 ? Math.min(size, userLimit - offset) : size };
}

/** "5 values" etc. for the schema hints. */
export function fieldHint(f: DigestField): string {
  const bits: string[] = [];
  if (f.enumValues) bits.push(t("mongo.hint.values", { n: f.enumValues }));
  if (f.trap) bits.push(f.trap);
  if (f.presence < 0.95) bits.push(`${Math.round(f.presence * 100)}%`);
  return bits.join(" · ");
}

export function plainTypes(f: DigestField): string {
  return f.types.map((t) => t.type).join(" | ");
}

/** Sensitive paths, including their children. */
export function sensitivePaths(d: SchemaDigest | undefined): Set<string> {
  return new Set((d?.fields ?? []).filter((f) => f.sensitive).map((f) => f.path));
}

/** Whether a path (array indexes ignored) or any of its parents is a sensitive field of the digest. */
export function isSensitivePath(sens: Set<string>, path: readonly string[]): boolean {
  const named = path.filter((p) => !/^\d+$/.test(p));
  for (let n = named.length; n > 0; n--) if (sens.has(named.slice(0, n).join("."))) return true;
  return false;
}

/** A short sentence per plan stage for the Explain view's badges. */
export function stageVerdict(stage: string, estimated?: number): { tone: "ok" | "warn" | "danger"; text: string } {
  if (stage === "COLLSCAN") return (estimated ?? 0) > 50_000 ? { tone: "danger", text: t("mongo.stage.collscanBig") } : { tone: "warn", text: t("mongo.stage.collscan") };
  if (stage === "SORT") return { tone: "warn", text: t("mongo.stage.sort") };
  if (stage === "IXSCAN") return { tone: "ok", text: t("mongo.stage.ixscan") };
  return { tone: "ok", text: t("mongo.stage.ok") };
}

export const levelLabel = (l: EffectiveLevel): string => (l === "productionLevel" ? t("mongo.level.production") : t("mongo.level.local"));

export function newId(prefix = "m"): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

const zoneFormat = (timeZone: string | null) => new Intl.DateTimeFormat("sv-SE", { timeZone: timeZone ?? undefined, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * The date boundaries of a filter text (`{"$date":"..."}` or `ISODate("...")`) as "field from 2026-09-30 00:00 Budapest" (`null` = the viewer's own zone)
 * chips, so a reading such as "last 3 days = since local midnight" is visible instead of buried in the assumptions.
 */
export function dateBounds(filter: string, timeZone: string | null = "Europe/Budapest"): string[] {
  const out: string[] = [];
  const fmt = zoneFormat(timeZone);
  const zone = timeZone ? (timeZone.split("/").pop() ?? timeZone).replace(/_/g, " ") : fmt.resolvedOptions().timeZone;
  const re = /"?([A-Za-z_][\w.]*)"?\s*:\s*\{\s*"?\$(gte|gt|lte|lt)"?\s*:\s*(?:\{\s*"\$date"\s*:\s*"([^"]+)"\s*\}|ISODate\(\s*["']([^"']+)["']\s*\))/g;
  for (const m of filter.matchAll(re)) {
    const ms = Date.parse(m[3] ?? m[4]);
    if (Number.isNaN(ms)) continue;
    const key = `mongo.dateBound.${m[2]}` as "mongo.dateBound.gte" | "mongo.dateBound.gt" | "mongo.dateBound.lte" | "mongo.dateBound.lt";
    out.push(t(key, { field: m[1], when: fmt.format(new Date(ms)).replace(",", ""), zone }));
  }
  return out.slice(0, 4);
}

/** The Generic preset's sample questions; `presetOf(profile.domain).samplePrompts` is the per-profile list. */
export const AI_EXAMPLES: readonly string[] = generic.samplePrompts;

export interface UriReading {
  ok: boolean;
  /** `scheme` (not mongodb://) or `parse`. */
  error?: string;
  /** Display host with no credentials, e.g. `127.0.0.1:27017` or `cluster0.example.net (srv)`. */
  host: string;
  srv: boolean;
  tls: boolean;
  hasCredentials: boolean;
  level: EffectiveLevel;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * A preview of what a typed connection string means (host, TLS, credentials, level). Display only: Rust parses the string
 * again when it is saved and decides the real level. Credentials are never part of the result.
 */
export function readUri(uri: string): UriReading {
  const m = /^(mongodb(?:\+srv)?):\/\/(?:([^@/]*)@)?([^/?]+)(?:\/([^?]*))?(?:\?(.*))?$/.exec(uri.trim());
  if (!m) return { ok: false, error: /^mongodb/.test(uri.trim()) ? "parse" : "scheme", host: "", srv: false, tls: false, hasCredentials: false, level: "productionLevel" };
  const srv = m[1] === "mongodb+srv";
  const first = m[3].split(",")[0];
  const bare = first.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  const loopback = LOOPBACK_HOSTS.has(bare);
  return { ok: true, host: srv ? `${first} (srv)` : first, srv, tls: srv || /tls=true|ssl=true/i.test(m[5] ?? ""), hasCredentials: !!m[2], level: srv || !loopback ? "productionLevel" : "local" };
}

// --- the structured connection (ConnSpec): pure helpers shared by the form, the wizard, the store and the mock -------------

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const isLoopbackHost = (h: string) => LOOPBACK_NAMES.has(h.trim().toLowerCase());

/** Every host the driver would be given, as `host[:port]`. */
export const specHosts = (spec: ConnSpec): string[] => (spec.hosts ?? []).map((h) => (h.port ? `${h.host}:${h.port}` : h.host));

/**
 * Mirror of the Rust host rule for the form's "Why is this Production-level?" line (Rust decides the real level): any tunnel,
 * any `+srv` host and any non-loopback host is production-level.
 */
export function levelOfSpec(spec: ConnSpec): { level: EffectiveLevel; reason: "tunnel" | "srv" | "remoteHost" | "loopback"; host?: string } {
  if ((spec.tunnel?.kind ?? "none") !== "none") return { level: "productionLevel", reason: "tunnel" };
  if (spec.scheme === "srv") return { level: "productionLevel", reason: "srv", host: spec.hosts?.[0]?.host };
  const remote = (spec.hosts ?? []).find((h) => !isLoopbackHost(h.host));
  return remote ? { level: "productionLevel", reason: "remoteHost", host: remote.host } : { level: "local", reason: "loopback" };
}

/** A fast 53-bit string hash (cyrb53). An equality token only, never a security primitive: the signature lives in Rust. */
function hash53(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/**
 * The destination a secret was typed for (spec 5.5 `secret_identity`): scheme, hosts and ports, tunnel kind and endpoint,
 * mechanism, user name and TLS mode. A stored, drafted or session-cached secret is used only while this stays equal.
 */
export function connIdentity(spec: ConnSpec): string {
  const tun = spec.tunnel ?? { kind: "none" as const };
  const parts = [
    `scheme=${spec.scheme ?? "standard"}`,
    ...(spec.hosts ?? []).map((h) => `host=${h.host.trim().toLowerCase()}:${h.port ?? ""}`),
    `tunnel=${tun.kind}`,
    ...(tun.kind === "ssh" ? [`ssh=${tun.host.trim().toLowerCase()}:${tun.port ?? ""}:${tun.user}`] : []),
    ...(tun.kind === "socks5" ? [`proxy=${tun.host.trim().toLowerCase()}:${tun.port}`] : []),
    `mech=${spec.auth?.mechanism ?? "default"}`,
    `user=${spec.auth?.username ?? ""}`,
    `tls=${spec.tls?.mode ?? "auto"}`,
  ];
  return hash53(parts.join("\n"));
}

const HOST_RE = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]{1,253})$/;
const NAME_RE = /^[A-Za-z0-9 ._-]{1,64}$/;
const SOURCE_RE = /^[A-Za-z0-9_$.-]+$/;
const DB_BAD = /[\\/.\s"$\0]/;
const EXTRA_KEYS = new Set(["maxpoolsize", "minpoolsize", "maxidletimems", "heartbeatfrequencyms", "localthresholdms", "readconcernlevel", "srvmaxhosts", "srvservicename", "loadbalanced"]);

const badPath = (p: string | null | undefined): string | undefined => {
  if (!p) return undefined;
  if (p.length > 1024 || p.includes("\0") || p.split("/").includes("..")) return "path.invalid";
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) ? undefined : "path.notAbsolute";
};

/**
 * UI mirror of `ConnSpec::validate` (Rust is the authority and runs it again on save, test and connect): the problems the form
 * shows inline. `code` is an i18n key suffix; `warning` problems do not block a save. File existence is not checked here.
 */
export function validateSpec(spec: ConnSpec): FieldProblem[] {
  const out: FieldProblem[] = [];
  const add = (path: string, code: string, warning = false) => out.push(warning ? { path, code, warning } : { path, code });
  const hosts = spec.hosts ?? [];
  const srv = spec.scheme === "srv";
  if (!hosts.length) add("hosts", "hosts.required");
  if (hosts.length > 16) add("hosts", "hosts.tooMany");
  if (srv && hosts.length > 1) add("hosts", "srv.oneHost");
  hosts.forEach((h, i) => {
    if (!HOST_RE.test(h.host) || h.host.startsWith("-")) add(`hosts.${i}.host`, "host.invalid");
    if (srv && h.port != null) add(`hosts.${i}.port`, "srv.noPort");
    else if (h.port != null && !(Number.isInteger(h.port) && h.port >= 1 && h.port <= 65535)) add(`hosts.${i}.port`, "port.range");
  });
  const db = spec.database ?? "";
  if (db && (db.length > 120 || DB_BAD.test(db))) add("database", "database.invalid");
  const top = spec.topology ?? {};
  if (srv && top.directConnection) add("topology.directConnection", "srv.noDirect");
  if (top.replicaSet && !NAME_RE.test(top.replicaSet)) add("topology.replicaSet", "replicaSet.invalid");
  if (spec.appName && !NAME_RE.test(spec.appName)) add("appName", "appName.invalid");
  if (top.maxStalenessS != null && top.maxStalenessS < 90) add("topology.maxStalenessS", "staleness.min");
  const pref = top.readPreference ?? "auto";
  if (pref.startsWith("secondary") && !top.replicaSet && !srv) add("topology.readPreference", "select.noReplicaSet", true);
  const auth = spec.auth ?? {};
  const mech = auth.mechanism ?? "default";
  if (auth.source && !SOURCE_RE.test(auth.source)) add("auth.source", "source.invalid");
  if (mech === "x509" && !spec.tls?.clientCertFile) add("tls.clientCertFile", "x509.needsCert");
  for (const [path, v] of [["tls.caFile", spec.tls?.caFile], ["tls.clientCertFile", spec.tls?.clientCertFile], ["tunnel.keyFile", spec.tunnel?.kind === "ssh" ? spec.tunnel.keyFile : undefined]] as const) {
    const code = badPath(v);
    if (code) add(path, code);
  }
  const comp = spec.compressors ?? [];
  if (new Set(comp).size !== comp.length) add("compressors", "compressor.duplicate");
  for (const [i, e] of (spec.extra ?? []).entries()) if (!EXTRA_KEYS.has(e.key.toLowerCase())) add(`extra.${i}.key`, "extra.notAllowed");
  const tun = spec.tunnel ?? { kind: "none" as const };
  if (tun.kind === "ssh") {
    if (!tun.host || !HOST_RE.test(tun.host) || tun.host.startsWith("-")) add("tunnel.host", "ssh.host");
    if (!/^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(tun.user ?? "")) add("tunnel.user", "ssh.user");
    if (tun.keyFile && tun.auth !== "keyFile") add("tunnel.keyFile", "ssh.keyFileAuth");
    for (const [i, a] of (tun.allowedHosts ?? []).entries()) {
      if (!HOST_RE.test(a.host) || a.host.startsWith("[") || /^169\.254\./.test(a.host) || /^fe80:/i.test(a.host)) add(`tunnel.allowedHosts.${i}`, "allowed.invalid");
    }
  } else if (tun.kind === "socks5") {
    if (!tun.host || !HOST_RE.test(tun.host)) add("tunnel.host", "proxy.host");
    if (!(tun.port >= 1 && tun.port <= 65535)) add("tunnel.port", "port.range");
  }
  const remote = tun.kind !== "none" || hosts.some((h) => !isLoopbackHost(h.host));
  if (remote && (spec.tls?.mode ?? "auto") === "off" && (mech === "plain" || (auth.savePassword && mech !== "none" && mech !== "x509"))) add("tls.mode", "config.plainRemote");
  return out;
}

export type StartingPoint = "atlas" | "local" | "network" | "ssh" | "string";

/** Appendix B1: the form defaults of each starting point of the wizard (the tag is pre-set from the host rule). */
export function startingSpec(kind: StartingPoint): { spec: ConnSpec; environment: Environment } {
  switch (kind) {
    case "atlas":
      return { spec: { scheme: "srv", hosts: [{ host: "" }], auth: { mechanism: "default", source: "admin", savePassword: true }, tls: { mode: "auto" }, tunnel: { kind: "none" } }, environment: "production" };
    case "local":
      return { spec: { scheme: "standard", hosts: [{ host: "127.0.0.1", port: 27017 }], auth: { mechanism: "none" }, tls: { mode: "auto" }, tunnel: { kind: "none" } }, environment: "local" };
    case "ssh":
      return { spec: { scheme: "standard", hosts: [{ host: "", port: 27017 }], auth: { mechanism: "default", savePassword: true }, tls: { mode: "auto" }, tunnel: { kind: "ssh", host: "", user: "", auth: "agent", useSshConfig: true, allowedHosts: [] } }, environment: "production" };
    default:
      return { spec: { scheme: "standard", hosts: [{ host: "", port: 27017 }], auth: { mechanism: "default", savePassword: true }, tls: { mode: "auto" }, tunnel: { kind: "none" } }, environment: "production" };
  }
}

/** The caller's UTC offset (minutes east of UTC) and IANA zone, for the AI request: the Generic preset words dates in them (D24). */
export function callerZone(): { utcOffsetMin: number; tzName: string } {
  return { utcOffsetMin: -new Date().getTimezoneOffset(), tzName: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" };
}
