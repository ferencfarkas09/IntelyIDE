// Pure model of the connection form: the editable state, its mapping to and from `ProfileInput` / `ProfileView`, the problem
// list, and the typed-confirmation rules. No DOM, no ipc, no secrets: passwords live in the component's own signals and are
// merged into the input by `toInput`. Rust re-validates everything (`ConnSpec::validate`); this is the form's own mirror.
import type {
  AiMode,
  AllowedHost,
  AuthSpec,
  Compressor,
  ConnSpec,
  Domain,
  Environment,
  ExtraOption,
  FieldProblem,
  GlossaryPair,
  HostPort,
  Note,
  ProfileInput,
  ProfileView,
  TlsRelax,
  TlsSpec,
  Timeouts,
  TopologySpec,
  Tunnel,
  UriParse,
} from "../../../bindings/mongo";
import { levelOfSpec, validateSpec } from "../logic";

export type FormTab = "connection" | "auth" | "tls" | "tunnel" | "advanced" | "safety" | "ai";
export const FORM_TABS: readonly FormTab[] = ["connection", "auth", "tls", "tunnel", "advanced", "safety", "ai"];

export type Spec = ConnSpec & { hosts: HostPort[]; auth: AuthSpec; tls: TlsSpec; topology: TopologySpec; timeouts: Timeouts; compressors: Compressor[]; extra: ExtraOption[]; tunnel: Tunnel };

export interface FormState {
  name: string;
  environment: Environment;
  /** The user picked the tag by hand: stop following the host rule. */
  envTouched: boolean;
  color: string | undefined;
  group: string;
  favorite: boolean;
  spec: Spec;
  /** SSH "allowed database hosts" as `host:port` rows (the text the user edits; parsed on the way out). */
  allowed: string[];
  maxTimeS: string;
  tenant: string;
  aiMode: AiMode;
  domain: Domain;
  denyFields: string[];
  glossary: GlossaryPair[];
  tlsRelax: TlsRelax;
  /** The host typed to lower the level (Safety tab). */
  typedHost: string;
  /** The user removed an override that was already saved. */
  overrideCleared: boolean;
  /** The connection name typed to confirm a lowering. */
  confirm: string;
}

export const COLORS = ["#4f9d69", "#d9a441", "#e5484d", "#5b8def", "#9b6dd6", "#2fb3b3", "#8a8f98"] as const;
export const DEFAULT_COLOR: Record<Environment, string> = { local: "#4f9d69", sandbox: "#d9a441", production: "#e5484d" };

/** Extra options the form offers (spec 5.4 allow-list), with their clamps. `enum` ones list their values. */
export interface ExtraDef {
  key: string;
  min?: number;
  max?: number;
  values?: readonly string[];
}
export const EXTRA_DEFS: readonly ExtraDef[] = [
  { key: "maxPoolSize", min: 1, max: 8 },
  { key: "minPoolSize", min: 0, max: 4 },
  { key: "maxIdleTimeMS", min: 1000, max: 3_600_000 },
  { key: "heartbeatFrequencyMS", min: 500, max: 60_000 },
  { key: "localThresholdMS", min: 0, max: 1000 },
  { key: "readConcernLevel", values: ["local", "majority", "available"] },
  { key: "srvMaxHosts", min: 0, max: 16 },
  { key: "srvServiceName" },
  { key: "loadBalanced", values: ["true"] },
];
export const extraDef = (key: string): ExtraDef | undefined => EXTRA_DEFS.find((d) => d.key.toLowerCase() === key.toLowerCase());

export const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
export const isLoopback = (h: string): boolean => LOOPBACK.has(h.trim().toLowerCase());

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v ?? null)) as T;

/** Every nested object exists, so the form can bind to `spec.auth.username` without guards. */
export function normalizeSpec(s?: ConnSpec | null): Spec {
  const c = clone(s ?? {}) as ConnSpec;
  const scheme = c.scheme ?? "standard";
  const hosts = c.hosts?.length ? c.hosts : [{ host: "", port: scheme === "srv" ? null : 27017 }];
  return {
    ...c,
    scheme,
    hosts,
    database: c.database ?? null,
    auth: { mechanism: "default", username: null, source: null, savePassword: true, ...c.auth },
    tls: { mode: "auto", caFile: null, clientCertFile: null, saveKeyPassword: false, ...c.tls },
    topology: { replicaSet: null, directConnection: null, readPreference: "auto", maxStalenessS: null, ...c.topology },
    compressors: c.compressors ?? [],
    timeouts: { connectMs: null, serverSelectionMs: null, ...c.timeouts },
    appName: c.appName ?? null,
    extra: c.extra ?? [],
    tunnel: c.tunnel ?? { kind: "none" },
  };
}

export const newSshTunnel = (): Extract<Tunnel, { kind: "ssh" }> => ({ kind: "ssh", host: "", port: null, user: "", auth: "agent", keyFile: null, saveSecret: true, useSshConfig: true, allowedHosts: [] });
export const newProxyTunnel = (): Extract<Tunnel, { kind: "socks5" }> => ({ kind: "socks5", host: "", port: 1080, username: null, savePassword: false });

export const allowedToRows = (a: readonly AllowedHost[] | undefined): string[] => (a ?? []).map((h) => `${h.host}:${h.port}`);

/** `host:port` to an entry; undefined when it is not one (no IPv6 literals in v1). */
export function parseAllowed(row: string): AllowedHost | undefined {
  const m = /^([A-Za-z0-9._-]{1,253}):(\d{1,5})$/.exec(row.trim());
  if (!m) return undefined;
  const port = Number(m[2]);
  return port >= 1 && port <= 65535 ? { host: m[1], port } : undefined;
}

/** The host rule for a fresh tag: loopback is Local, anything else Production. */
export const autoEnvironment = (spec: ConnSpec): Environment => (levelOfSpec(spec).level === "local" ? "local" : "production");

export interface FormOptions {
  profile?: ProfileView;
  defaultAi: AiMode;
  /** The Happy preset switch (`mongo.happyPreset`): new profiles default to the Happy domain. */
  happyPreset?: boolean;
  /** Pre-filled by the wizard. */
  initial?: { spec: ConnSpec; environment?: Environment; name?: string };
}

export function initialState(o: FormOptions): FormState {
  const p = o.profile;
  const spec = normalizeSpec(p?.spec ?? o.initial?.spec);
  return {
    name: p?.name ?? o.initial?.name ?? "",
    environment: p?.environment ?? o.initial?.environment ?? autoEnvironment(spec),
    envTouched: !!p || !!o.initial?.environment,
    color: p?.color || undefined,
    group: p?.group ?? "",
    favorite: p?.favorite ?? false,
    spec,
    allowed: spec.tunnel.kind === "ssh" ? allowedToRows(spec.tunnel.allowedHosts) : [],
    maxTimeS: String(Math.round((p?.maxTimeMs ?? 15000) / 1000)),
    tenant: p?.tenantLock ?? "",
    aiMode: p?.aiMode ?? o.defaultAi,
    domain: p?.domain ?? (o.happyPreset ? "happy" : "generic"),
    denyFields: [...(p?.aiPrefs?.denyFields ?? [])],
    glossary: (p?.aiPrefs?.glossary ?? []).map((g) => ({ ...g })),
    tlsRelax: p?.tlsRelax ?? "none",
    typedHost: "",
    overrideCleared: false,
    confirm: "",
  };
}

/** The spec as it goes to Rust: empty strings become null, tunnel rows are parsed, nothing that does not apply is sent. */
export function cleanSpec(state: Pick<FormState, "spec" | "allowed">): ConnSpec {
  const s = clone(state.spec);
  const nul = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
  const srv = s.scheme === "srv";
  s.hosts = s.hosts.map((h) => ({ host: h.host.trim(), port: srv ? null : (h.port ?? null) }));
  if (srv) s.hosts = s.hosts.slice(0, 1);
  s.database = nul(s.database);
  const mech = s.auth.mechanism ?? "default";
  s.auth.username = mech === "none" ? null : nul(s.auth.username);
  s.auth.source = mech === "x509" || mech === "plain" ? "$external" : nul(s.auth.source);
  s.tls.caFile = nul(s.tls.caFile);
  s.tls.clientCertFile = nul(s.tls.clientCertFile);
  s.topology.replicaSet = nul(s.topology.replicaSet);
  if (srv) s.topology.directConnection = null;
  if (!(s.topology.readPreference ?? "auto").match(/^(secondary|secondaryPreferred|nearest)$/)) s.topology.maxStalenessS = null;
  s.appName = nul(s.appName);
  s.extra = s.extra.filter((e) => e.key.trim() && e.value.trim()).map((e) => ({ key: e.key.trim(), value: e.value.trim() }));
  const t = s.tunnel;
  if (t.kind === "ssh") {
    t.host = t.host.trim();
    t.user = t.user.trim();
    t.keyFile = t.auth === "keyFile" ? nul(t.keyFile) : null;
    t.allowedHosts = state.allowed.map(parseAllowed).filter((a): a is AllowedHost => !!a);
  } else if (t.kind === "socks5") {
    t.host = t.host.trim();
    t.username = nul(t.username);
  }
  return s;
}

export const hostRule = (state: Pick<FormState, "spec" | "allowed">) => levelOfSpec(cleanSpec(state));

/** The host the user must type to lower the level: the tunnel's host, else the first non-loopback host. */
export function overrideHostOf(state: Pick<FormState, "spec" | "allowed">): string {
  const t = state.spec.tunnel;
  if (t.kind !== "none") return t.host.trim();
  return hostRule(state).host ?? state.spec.hosts[0]?.host.trim() ?? "";
}

export interface OverrideInfo {
  /** The override is in force after this save. */
  active: boolean;
  /** The input carries `levelOverrideHost` (newly typed). */
  typedNow: boolean;
  /** The input carries `""` (the user removed a saved override). */
  clearing: boolean;
}
export function overrideState(state: FormState, old?: ProfileView): OverrideInfo {
  const host = overrideHostOf(state);
  const rule = hostRule(state).level === "productionLevel";
  const typedNow = rule && !!host && state.typedHost.trim().toLowerCase() === host.toLowerCase();
  const saved = !!old?.levelOverride && !state.overrideCleared;
  const clearing = !!old?.levelOverride && state.overrideCleared && !typedNow;
  return { active: typedNow || saved, typedNow: typedNow && !saved, clearing };
}

/** The level after this save: the tag and the host rule raise it, only the typed host lowers the host rule. */
export function effectiveLevelOf(state: FormState, old?: ProfileView): "local" | "productionLevel" {
  if (state.environment === "production") return "productionLevel";
  if (overrideState(state, old).active) return "local";
  return hostRule(state).level;
}

const TAG_RANK: Record<Environment, number> = { local: 0, sandbox: 1, production: 2 };
const AI_RANK: Record<AiMode, number> = { off: 0, schemaOnly: 1, schemaEnums: 2 };

export type LoweringReason = "ai" | "override" | "relax" | "deny" | "tag";
/** What needs the typed connection name (spec 5.5): raising safety needs nothing, lowering it does. */
export function loweringReasons(state: FormState, old?: ProfileView): LoweringReason[] {
  const out: LoweringReason[] = [];
  if (AI_RANK[state.aiMode] > AI_RANK[old?.aiMode ?? "off"]) out.push("ai");
  if (overrideState(state, old).typedNow) out.push("override");
  if (state.tlsRelax === "certificates" && old?.tlsRelax !== "certificates") out.push("relax");
  const kept = new Set(state.denyFields.map((f) => f.trim()).filter(Boolean));
  if ((old?.aiPrefs?.denyFields ?? []).some((f) => !kept.has(f))) out.push("deny");
  if (old && TAG_RANK[state.environment] < TAG_RANK[old.environment]) out.push("tag");
  return out;
}

export const confirmed = (state: FormState, old?: ProfileView): boolean => loweringReasons(state, old).length === 0 || state.confirm.trim() === state.name.trim();

/** `tlsRelax` is refused when the EFFECTIVE level is Production (D10); the option is then not offered. */
export const relaxAllowed = (state: FormState, old?: ProfileView): boolean => effectiveLevelOf({ ...state, tlsRelax: "none" }, old) === "local";

// --- problems ---------------------------------------------------------------------------------------------------------------

export interface Problem extends FieldProblem {
  tab: FormTab | "header";
}

export function tabOfPath(path: string): FormTab | "header" {
  if (path === "name") return "header";
  if (path.startsWith("auth")) return "auth";
  if (path.startsWith("tls")) return "tls";
  if (path.startsWith("tunnel")) return "tunnel";
  if (path === "appName" || path.startsWith("extra") || path.startsWith("compressors") || path.startsWith("timeouts") || path === "maxTime") return "advanced";
  if (path.startsWith("tenant") || path.startsWith("override")) return "safety";
  if (path.startsWith("ai")) return "ai";
  return "connection";
}

/** The element id a field with this path carries, so the error summary can focus it. */
export const fieldId = (path: string): string => `mgf-${path.replace(/[^A-Za-z0-9]+/g, "-")}`;

export function problemsOf(state: FormState, opts: { needsConnection?: boolean } = {}): Problem[] {
  const out: FieldProblem[] = [];
  if (!state.name.trim()) out.push({ path: "name", code: "name.required" });
  if (state.name.trim().length > 80) out.push({ path: "name", code: "name.long" });
  if (opts.needsConnection !== false) {
    const spec = cleanSpec(state);
    // An empty host is "required", not also "invalid".
    out.push(...validateSpec(spec).filter((p) => !(p.code === "host.invalid" && /^hosts\.(\d+)\.host$/.test(p.path) && !spec.hosts?.[Number(p.path.split(".")[1])]?.host)));
    spec.hosts?.forEach((h, i) => {
      if (!h.host) out.push({ path: `hosts.${i}.host`, code: "host.required" });
    });
    if (spec.tunnel?.kind === "ssh" && !spec.tunnel.host) out.push({ path: "tunnel.host", code: "ssh.hostRequired" });
    if (spec.tunnel?.kind === "socks5" && !spec.tunnel.host) out.push({ path: "tunnel.host", code: "proxy.hostRequired" });
    if (spec.tunnel?.kind === "ssh" && spec.tunnel.auth === "keyFile" && !spec.tunnel.keyFile) out.push({ path: "tunnel.keyFile", code: "ssh.keyFileRequired" });
    state.allowed.forEach((r, i) => {
      if (r.trim() && !parseAllowed(r)) out.push({ path: `tunnel.allowedHosts.${i}`, code: "allowed.format" });
    });
    // validateSpec already reports allowed.invalid for a bad host charset; parse failures above cover the rest.
    const dup = new Set<string>();
    for (const [i, e] of (spec.extra ?? []).entries()) {
      const k = e.key.toLowerCase();
      if (dup.has(k)) out.push({ path: `extra.${i}.key`, code: "extra.duplicate" });
      dup.add(k);
      const d = extraDef(e.key);
      if (d?.min != null) {
        const n = Number(e.value);
        if (!Number.isInteger(n) || n < d.min || n > (d.max ?? n)) out.push({ path: `extra.${i}.value`, code: "extra.range" });
      } else if (d?.values && !d.values.includes(e.value)) out.push({ path: `extra.${i}.value`, code: "extra.value" });
    }
    for (const k of ["connectMs", "serverSelectionMs"] as const) {
      const v = state.spec.timeouts[k];
      if (v != null && (v < 1000 || v > 60_000)) out.push({ path: `timeouts.${k}`, code: "timeout.range" });
    }
  }
  const mt = Number(state.maxTimeS);
  if (!Number.isInteger(mt) || mt < 1 || mt > 60) out.push({ path: "maxTime", code: "maxTime.range" });
  const seen = new Set<string>();
  const unique = out.filter((p) => (seen.has(`${p.path}|${p.code}`) ? false : (seen.add(`${p.path}|${p.code}`), true)));
  return unique.map((p) => ({ ...p, tab: tabOfPath(p.path) }));
}
export const blocking = (ps: readonly Problem[]): Problem[] => ps.filter((p) => !p.warning);

// --- secrets ----------------------------------------------------------------------------------------------------------------

export type SecretSlot = "password" | "keyPassword" | "sshSecret" | "proxyPassword";
export interface SecretValues {
  password: string;
  keyPassword: string;
  sshSecret: string;
  proxyPassword: string;
}
export const NO_SECRETS: SecretValues = { password: "", keyPassword: "", sshSecret: "", proxyPassword: "" };

/** Which secret slots the current spec uses at all (a field that does not apply is not shown and never sent). */
export function slotsInUse(spec: ConnSpec): SecretSlot[] {
  const out: SecretSlot[] = [];
  const mech = spec.auth?.mechanism ?? "default";
  if (mech !== "none" && mech !== "x509") out.push("password");
  if (spec.tls?.clientCertFile) out.push("keyPassword");
  const t = spec.tunnel;
  if (t?.kind === "ssh" && t.auth !== "agent") out.push("sshSecret");
  if (t?.kind === "socks5" && t.username) out.push("proxyPassword");
  return out;
}

export interface ToInputOptions {
  state: FormState;
  old?: ProfileView;
  secrets: SecretValues;
  /** Slots the user explicitly cleared ("Forget the saved password"). */
  cleared?: readonly SecretSlot[];
  draft?: string | null;
  /** The legacy profile was not converted: send only what does not touch the connection. */
  legacyKept?: boolean;
}

export function toInput(o: ToInputOptions): ProfileInput {
  const { state, old } = o;
  const spec = cleanSpec(state);
  const lowering = loweringReasons(state, old).length > 0;
  const ov = overrideState(state, old);
  const input: ProfileInput = {
    id: old?.id,
    name: state.name.trim(),
    environment: state.environment,
    color: state.color ?? DEFAULT_COLOR[state.environment],
    readOnly: true,
    aiMode: state.aiMode,
    tenantLock: state.tenant.trim(),
    maxTimeMs: Math.min(60, Math.max(1, Number(state.maxTimeS) || 15)) * 1000,
    group: state.group.trim(),
    favorite: state.favorite,
    domain: state.domain,
    aiPrefs: { denyFields: state.denyFields.map((f) => f.trim()).filter(Boolean), glossary: state.glossary.filter((g) => g.from.trim() && g.to.trim()).map((g) => ({ from: g.from.trim(), to: g.to.trim() })) },
    tlsRelax: state.tlsRelax,
    confirm: lowering ? state.confirm.trim() : undefined,
  };
  if (ov.typedNow) input.levelOverrideHost = overrideHostOf(state);
  else if (ov.clearing) input.levelOverrideHost = "";
  if (!o.legacyKept) {
    input.spec = spec;
    const inUse = new Set(slotsInUse(spec));
    for (const slot of ["password", "keyPassword", "sshSecret", "proxyPassword"] as const) {
      const v = o.secrets[slot];
      if (v && inUse.has(slot)) input[slot] = v;
      else if (o.cleared?.includes(slot) || (!inUse.has(slot) && !!old && hadSecret(old, slot))) input[slot] = "";
    }
    if (o.draft) input.draft = o.draft;
  }
  return input;
}

function hadSecret(p: ProfileView, slot: SecretSlot): boolean {
  return slot === "password" ? p.hasPassword : slot === "keyPassword" ? p.hasKeyPassword : slot === "sshSecret" ? p.hasSshSecret : p.hasProxyPassword;
}

/** A saved secret is kept only while the destination is unchanged; otherwise Rust drops it, and the form says so. */
export const secretsWillBeDropped = (identityNow: string, identityOld: string | undefined, old?: ProfileView): boolean =>
  !!old && !!identityOld && identityNow !== identityOld && (old.hasPassword || old.hasKeyPassword || old.hasSshSecret || old.hasProxyPassword);

// --- URI paste --------------------------------------------------------------------------------------------------------------

export const looksLikeUri = (text: string): boolean => /^\s*mongodb(\+srv)?:\/\//i.test(text);

export interface NoteGroups {
  /** Informational, collapsed by default (read-only options such as retryWrites). */
  info: Note[];
  warnings: Note[];
  unsupported: Note[];
}
export function groupNotes(p: Pick<UriParse, "warnings" | "unsupported">): NoteGroups {
  return { info: p.warnings.filter((n) => n.code === "ignoredReadOnly"), warnings: p.warnings.filter((n) => n.code !== "ignoredReadOnly"), unsupported: p.unsupported };
}

/** A pasted Atlas template leaves the password unknown: the form focuses the password field. */
export const wantsPassword = (p: Pick<UriParse, "warnings">): boolean => p.warnings.some((n) => n.code === "placeholderPassword");

/** Applies a parsed string to the state, keeping what the string does not carry (name, tag choice, AI, safety). */
export function applyParsed(state: FormState, parsed: UriParse): FormState {
  const spec = normalizeSpec(parsed.spec);
  const next: FormState = { ...state, spec, allowed: spec.tunnel.kind === "ssh" ? allowedToRows(spec.tunnel.allowedHosts) : [] };
  if (!state.envTouched) next.environment = autoEnvironment(spec);
  return next;
}

/** The spec with a changed scheme: SRV keeps the first host and no ports, Standard puts the default port back. */
export function withScheme(spec: Spec, scheme: "standard" | "srv"): Spec {
  if (spec.scheme === scheme) return spec;
  if (scheme === "srv") return { ...spec, scheme, hosts: [{ host: spec.hosts[0]?.host ?? "", port: null }], topology: { ...spec.topology, directConnection: null } };
  return { ...spec, scheme, hosts: spec.hosts.map((h) => ({ host: h.host, port: h.port ?? 27017 })) };
}
