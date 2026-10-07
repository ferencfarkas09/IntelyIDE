import type {
  AiCapabilities,
  AiMode,
  CancelView,
  ConnectionView,
  ConnSpec,
  Diagnosis,
  DialogHandle,
  EffectiveLevel,
  Environment,
  ErrorClass,
  ExportOptions,
  HostKeyView,
  ImportItem,
  ImportPreview,
  ImportReport,
  MongoCoreIpc,
  Note,
  Notice,
  ProfileDraft,
  ProfileInput,
  ProfileMeta,
  ProfileView,
  ReadCommand,
  ReadPreference,
  RoleChip,
  SecretKind,
  SecretsStatus,
  SessionSecrets,
  SshSpec,
  StepId,
  StepState,
  StudioStatus,
  TestEvent,
  TestReport,
  TestStep,
  UriParse,
  WindowView,
} from "../mongoCore";
import type { Domain } from "../mongoCore";
import { connIdentity, levelOfSpec, validateSpec } from "../../modules/mongo/logic";

/**
 * In-memory MongoDB Studio connection manager for the mock IPC and the vitest suites (`createMockMongoEngine`), plus a
 * small synthetic data set (`createMockMongoCore`). It follows the Rust rules that matter to the UI: off by default,
 * `mongoDisabled` while off (except the exempt commands), read-only profiles, lowering a safety setting needs the typed name,
 * any non-loopback host and any tunnel is Production-level, secrets are write-only and bound to the destination they were
 * typed for (identity), a pasted connection string is parsed into a spec while its password stays in a draft vault, the
 * stepper streams `mongo:test` events with a failure injection for every diagnosis code, dialog handles are one-time and
 * the webview never supplies a path. No real server, no network, no password is ever echoed.
 *
 * Failure injection: a host name, user name or tunnel host containing `inject-<code>` makes the test fail with that
 * diagnosis, e.g. `inject-tls-unknownIssuer.example.test` (dots and dashes in the code are optional, case is ignored).
 * Legacy markers kept for older tests: `badauth` (sign-in fails), `unreachable` / `timeout` (no answer).
 */

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)$/i;
const MAX_DOCS = 1000;
const TOTAL = 2400;
const STATUSES = ["open", "closed", "cancelled", "paid"];
const VAULT_TTL_MS = 10 * 60_000;
const VAULT_CAP = 16;
const HANDLE_TTL_MS = 5 * 60_000;
const MAX_IMPORT_BYTES = 1024 * 1024;

const err = (code: string, message: string) => ({ code, message });
function fail(code: string, message: string): never {
  throw err(code, message);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- connection strings: the mock's stand-in for the Rust parser and renderer ----------------------------------------------

/** Characters outside RFC 3986 "unreserved" are percent-encoded (a password may contain `@ : / % # ? [ ]`, spaces, unicode). */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const dec = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const ATLAS_PLACEHOLDER = /^<[a-z_]*(password|username)[a-z_]*>$/i;
const IGNORED_READONLY = new Set(["retrywrites", "retryreads", "w", "wtimeoutms", "journal", "readpreferencetags", "uuidrepresentation", "tlsdisableocspendpointcheck"]);
const EXTRA_KEYS: Record<string, string> = {
  maxpoolsize: "maxPoolSize", minpoolsize: "minPoolSize", maxidletimems: "maxIdleTimeMS", heartbeatfrequencyms: "heartbeatFrequencyMS", localthresholdms: "localThresholdMS",
  readconcernlevel: "readConcernLevel", srvmaxhosts: "srvMaxHosts", srvservicename: "srvServiceName", loadbalanced: "loadBalanced",
};
const MECH_IN: Record<string, "default" | "scramSha1" | "scramSha256" | "x509" | "plain"> = { default: "default", "scram-sha-1": "scramSha1", "scram-sha-256": "scramSha256", "mongodb-x509": "x509", plain: "plain" };
const MECH_OUT = { default: "", scramSha1: "SCRAM-SHA-1", scramSha256: "SCRAM-SHA-256", x509: "MONGODB-X509", plain: "PLAIN" } as const;
const PREF_IN: Record<string, "primary" | "primaryPreferred" | "secondary" | "secondaryPreferred" | "nearest"> = { primary: "primary", primarypreferred: "primaryPreferred", secondary: "secondary", secondarypreferred: "secondaryPreferred", nearest: "nearest" };

export interface ParsedConnection {
  spec: ConnSpec;
  password?: string;
  warnings: Note[];
  unsupported: Note[];
}

/**
 * `mongodb[+srv]://[user[:pass]@]hosts[/db][?options]` to a spec. Codes (Note.code): warnings `ignoredReadOnly` (info, collapse),
 * `duplicate`, `relativePath`, `unsupportedInBuild` (tlsAllowInvalidHostnames), `tlsRelaxRequested`, `placeholderPassword`,
 * `placeholderUsername`, `unknownCompressor`; unsupported `authMechanism`, `authMechanismProperties`, `gssapi`, `proxy`,
 * `autoEncryption`, `unknownOption`. Throws `mongoInvalid` when it is not a MongoDB string.
 */
export function parseConnection(input: string): ParsedConnection {
  const text = input.trim();
  const m = /^(mongodb(?:\+srv)?):\/\/(.+)$/s.exec(text);
  if (!m) return fail("mongoInvalid", "That is not a MongoDB connection string. It should start with mongodb:// or mongodb+srv://.");
  const srv = m[1] === "mongodb+srv";
  const q = m[2].indexOf("?");
  const head = q >= 0 ? m[2].slice(0, q) : m[2];
  const query = q >= 0 ? m[2].slice(q + 1) : "";
  const at = head.lastIndexOf("@");
  const userinfo = at >= 0 ? head.slice(0, at) : undefined;
  const afterAt = at >= 0 ? head.slice(at + 1) : head;
  const slash = afterAt.indexOf("/");
  const hostPart = slash >= 0 ? afterAt.slice(0, slash) : afterAt;
  const database = slash >= 0 ? dec(afterAt.slice(slash + 1)) : "";
  if (!hostPart.trim()) return fail("mongoInvalid", "That connection string has no host.");

  const warnings: Note[] = [];
  const unsupported: Note[] = [];
  const hosts = hostPart.split(",").map((h) => {
    const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(h);
    if (v6) return { host: `[${v6[1]}]`, ...(v6[2] ? { port: Number(v6[2]) } : {}) };
    const i = h.lastIndexOf(":");
    return i > 0 && /^\d+$/.test(h.slice(i + 1)) ? { host: h.slice(0, i), port: Number(h.slice(i + 1)) } : { host: h };
  });

  let username: string | undefined;
  let password: string | undefined;
  if (userinfo !== undefined) {
    const c = userinfo.indexOf(":");
    username = dec(c >= 0 ? userinfo.slice(0, c) : userinfo);
    password = c >= 0 ? dec(userinfo.slice(c + 1)) : undefined;
    if (username && ATLAS_PLACEHOLDER.test(username)) (warnings.push({ code: "placeholderUsername" }), (username = ""));
    if (password !== undefined && ATLAS_PLACEHOLDER.test(password)) (warnings.push({ code: "placeholderPassword" }), (password = undefined));
    if (password === "") password = undefined;
  }

  const spec: ConnSpec = {
    scheme: srv ? "srv" : "standard",
    hosts,
    database: database || null,
    auth: { mechanism: userinfo !== undefined ? "default" : "none", username: username || null, source: null, savePassword: true },
    tls: { mode: "auto", caFile: null, clientCertFile: null, saveKeyPassword: false },
    topology: { replicaSet: null, directConnection: null, readPreference: "auto", maxStalenessS: null },
    compressors: [],
    timeouts: {},
    appName: null,
    extra: [],
    tunnel: { kind: "none" },
  };
  const seen = new Set<string>();
  for (const pair of query.split("&").filter(Boolean)) {
    const eq = pair.indexOf("=");
    const rawKey = dec(eq >= 0 ? pair.slice(0, eq) : pair);
    const key = rawKey.toLowerCase();
    const val = dec(eq >= 0 ? pair.slice(eq + 1) : "");
    if (seen.has(key)) warnings.push({ code: "duplicate", option: rawKey });
    seen.add(key);
    const bool = /^true$/i.test(val);
    const path = (v: string, set: (p: string) => void) => {
      if (v.startsWith("~") || !v.startsWith("/")) warnings.push({ code: "relativePath", option: rawKey });
      set(v);
    };
    switch (key) {
      case "replicaset": spec.topology!.replicaSet = val || null; break;
      case "authsource": spec.auth!.source = val || null; break;
      case "authmechanism": {
        const mech = MECH_IN[val.toLowerCase()];
        if (!mech) unsupported.push({ code: "authMechanism", option: val });
        else {
          spec.auth!.mechanism = mech;
          if (mech === "x509" || mech === "plain") spec.auth!.source = "$external";
        }
        break;
      }
      case "authmechanismproperties": unsupported.push({ code: "authMechanismProperties", option: rawKey }); break;
      case "gssapiservicename": unsupported.push({ code: "gssapi", option: rawKey }); break;
      case "proxyhost": case "proxyport": case "proxyusername": case "proxypassword": unsupported.push({ code: "proxy", option: rawKey }); break;
      case "autoencryptionopts": unsupported.push({ code: "autoEncryption", option: rawKey }); break;
      case "tls": case "ssl": spec.tls!.mode = bool ? "on" : "off"; break;
      case "tlscafile": path(val, (p) => (spec.tls!.caFile = p)); break;
      case "tlscertificatekeyfile": path(val, (p) => (spec.tls!.clientCertFile = p)); break;
      case "tlsallowinvalidcertificates": if (bool) warnings.push({ code: "tlsRelaxRequested", option: rawKey }); break;
      case "tlsinsecure": if (bool) warnings.push({ code: "tlsRelaxRequested", option: rawKey }); break;
      case "tlsallowinvalidhostnames": warnings.push({ code: "unsupportedInBuild", option: rawKey }); break;
      case "directconnection": spec.topology!.directConnection = bool; break;
      case "readpreference": spec.topology!.readPreference = PREF_IN[val.toLowerCase()] ?? "auto"; break;
      case "maxstalenessseconds": spec.topology!.maxStalenessS = Number(val) || null; break;
      case "compressors":
        spec.compressors = val.split(",").map((c) => c.trim().toLowerCase()).filter((c, i, a) => c && a.indexOf(c) === i).flatMap((c) => (c === "zstd" || c === "zlib" || c === "snappy" ? [c] : (warnings.push({ code: "unknownCompressor", option: c }), [])));
        break;
      case "appname": spec.appName = val || null; break;
      case "connecttimeoutms": spec.timeouts!.connectMs = Number(val) || null; break;
      case "serverselectiontimeoutms": spec.timeouts!.serverSelectionMs = Number(val) || null; break;
      default:
        if (IGNORED_READONLY.has(key)) warnings.push({ code: "ignoredReadOnly", option: rawKey });
        else if (EXTRA_KEYS[key]) (spec.extra = spec.extra!.filter((e) => e.key !== EXTRA_KEYS[key])).push({ key: EXTRA_KEYS[key], value: val });
        else unsupported.push({ code: "unknownOption", option: rawKey });
    }
  }
  return { spec, password, warnings, unsupported };
}

/** The masked rendering of a spec (`user:***@`): what "Copy URI" copies. Never a password, never a passphrase. */
export function renderConnectionMasked(spec: ConnSpec): string {
  const hosts = (spec.hosts ?? []).map((h) => (h.port ? `${h.host}:${h.port}` : h.host)).join(",");
  const a = spec.auth ?? {};
  const mech = a.mechanism ?? "default";
  const user = mech !== "none" && a.username ? `${enc(a.username)}${mech === "x509" ? "" : ":***"}@` : "";
  const opts: string[] = [];
  const add = (k: string, v: string | number | null | undefined) => v !== null && v !== undefined && v !== "" && opts.push(`${k}=${enc(String(v))}`);
  add("authMechanism", mech in MECH_OUT ? MECH_OUT[mech as keyof typeof MECH_OUT] : "");
  add("authSource", a.source);
  const tls = spec.tls ?? {};
  if (tls.mode === "on") add("tls", "true");
  if (tls.mode === "off") add("tls", "false");
  add("tlsCAFile", tls.caFile);
  add("tlsCertificateKeyFile", tls.clientCertFile);
  const top = spec.topology ?? {};
  add("replicaSet", top.replicaSet);
  if (top.directConnection !== null && top.directConnection !== undefined) add("directConnection", String(top.directConnection));
  if (top.readPreference && top.readPreference !== "auto") add("readPreference", top.readPreference);
  add("maxStalenessSeconds", top.maxStalenessS);
  add("compressors", (spec.compressors ?? []).join(","));
  add("appName", spec.appName);
  add("connectTimeoutMS", spec.timeouts?.connectMs);
  add("serverSelectionTimeoutMS", spec.timeouts?.serverSelectionMs);
  for (const e of spec.extra ?? []) add(e.key, e.value);
  return `${spec.scheme === "srv" ? "mongodb+srv" : "mongodb"}://${user}${hosts}/${spec.database ? enc(spec.database) : ""}${opts.length ? `?${opts.join("&")}` : ""}`;
}

// --- diagnosis catalogue (Appendix B2) ---------------------------------------------------------------------------------------

interface DiagDef {
  class: ErrorClass;
  /** The step shown Failed (Warn for `authz.*`: the connection itself works). */
  step: StepId;
  detail: string;
  retryable?: boolean;
}
const D = (cls: ErrorClass, step: StepId, detail: string, retryable = true): DiagDef => ({ class: cls, step, detail, retryable });

export const MOCK_DIAGNOSES: Record<string, DiagDef> = {
  "config.invalid": D("config", "config", "a field failed validation", false),
  "config.fileMissing": D("config", "config", "the certificate file was not found", false),
  "config.pemInvalid": D("config", "config", "the file is not PEM", false),
  "config.unsupportedOption": D("config", "config", "this option is not supported", false),
  "config.needsSecret": D("config", "config", "a password is not saved", false),
  "config.plainRemote": D("config", "config", "plain text to a remote host", false),
  "config.tlsRelaxRefused": D("config", "config", "skipping certificate checks is not allowed at this level", false),
  "tunnel.noSsh": D("tunnel", "tunnel", "no usable ssh binary", false),
  "tunnel.auth": D("tunnel", "tunnel", "Permission denied (publickey)"),
  "tunnel.hostKeyUnknown": D("tunnel", "tunnel", "the host key is not known yet"),
  "tunnel.hostKeyChanged": D("tunnel", "tunnel", "the host key has changed", false),
  "tunnel.hostKeyUnscannable": D("tunnel", "tunnel", "the host cannot be scanned directly"),
  "tunnel.dns": D("tunnel", "tunnel", "could not resolve the bastion"),
  "tunnel.network": D("tunnel", "tunnel", "the bastion is unreachable"),
  "tunnel.forwardingDisabled": D("tunnel", "tunnel", "administratively prohibited", false),
  "tunnel.targetRefused": D("tunnel", "tunnel", "the bastion cannot reach the database host"),
  "tunnel.notAllowed": D("tunnel", "connect", "destination not in the allowed list", false),
  "tunnel.keyFile": D("tunnel", "tunnel", "the key file was not found", false),
  "tunnel.keyPerms": D("tunnel", "tunnel", "the key file permissions are too open", false),
  "tunnel.passphrase": D("tunnel", "tunnel", "wrong passphrase"),
  "tunnel.interactive": D("tunnel", "tunnel", "the server asks for more than a password", false),
  "tunnel.ipv6": D("tunnel", "connect", "IPv6 literal target", false),
  "tunnel.dropped": D("tunnel", "connect", "the ssh master ended"),
  "dns.notFound": D("dns", "dns", "host name does not resolve"),
  "dns.srv": D("dns", "dns", "SRV lookup failed"),
  "dns.txt": D("dns", "dns", "TXT lookup failed"),
  "net.refused": D("network", "connect", "connection refused"),
  "net.timeout": D("network", "connect", "connection timed out"),
  "net.unreachable": D("network", "connect", "network is unreachable"),
  "net.reset": D("network", "connect", "connection reset by peer"),
  "tls.unknownIssuer": D("tls", "tls", "invalid peer certificate: UnknownIssuer", false),
  "tls.hostname": D("tls", "tls", "invalid peer certificate: NotValidForName", false),
  "tls.expired": D("tls", "tls", "invalid peer certificate: Expired", false),
  "tls.clientCertRequired": D("tls", "tls", "received fatal alert: CertificateRequired", false),
  "tls.serverNotTls": D("tls", "tls", "the server does not speak TLS", false),
  "tls.serverRequiresTls": D("tls", "tls", "the server closes plain connections", false),
  "tls.pem": D("tls", "tls", "cannot read the PEM file", false),
  "auth.failed": D("auth", "auth", "Authentication failed.", false),
  "auth.mechanism": D("auth", "auth", "the mechanism is not offered", false),
  "auth.source": D("auth", "auth", "the user lives in another database", false),
  "auth.x509Subject": D("auth", "auth", "the certificate subject is not a user in $external", false),
  "authz.listDatabases": D("authz", "permissions", "not authorized to list databases", false),
  "authz.collection": D("authz", "permissions", "not authorized on this namespace", false),
  "authz.command": D("authz", "permissions", "not authorized to run this command", false),
  "select.noServer": D("selection", "connect", "No available servers"),
  "select.replicaSetName": D("selection", "connect", "the replica set name differs", false),
  "select.direct": D("selection", "connect", "direct versus discovery mismatch", false),
  "select.memberUnreachable": D("selection", "connect", "members advertise names this computer cannot reach"),
  "timeout.total": D("timeout", "connect", "server selection timed out after 8 seconds"),
};

const norm = (s: string) => s.toLowerCase().replace(/[.\-_]/g, "");
const NORMALIZED = new Map(Object.keys(MOCK_DIAGNOSES).map((c) => [norm(c), c]));

/** The diagnosis code a spec asks for through `inject-<code>` (or the legacy `badauth` / `unreachable` markers), if any. */
export function injectedCode(texts: (string | null | undefined)[]): string | undefined {
  for (const t of texts) {
    if (!t) continue;
    const hit = /inject[-_]([a-z0-9][a-z0-9_-]*)/i.exec(t);
    const code = hit && NORMALIZED.get(norm(hit[1]));
    if (code) return code;
    if (/badauth/i.test(t)) return "auth.failed";
    if (/unreachable|timeout/i.test(t)) return "timeout.total";
  }
  return undefined;
}

const fingerprintOf = (host: string, port: number) => {
  let h = 2166136261;
  for (const c of `${host.toLowerCase()}:${port}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let x = h;
  for (let i = 0; i < 43; i++) ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0), (out += b64[x >>> 26]));
  return `SHA256:${out}`;
};

// --- the engine -----------------------------------------------------------------------------------------------------------

export interface MockEngineOptions {
  /** Starts with the master switch on. */
  enabled?: boolean;
  compiled?: boolean;
  network?: "full" | "loopbackOnly" | "refused";
  /** Per step delay; 0 in tests. */
  latencyMs?: number;
  /** Injectable clock (vault and handle expiry, the one-test-per-second limit). */
  now?: () => number;
  /** Minimum gap between two test starts; default 1000 with a latency, 0 without. */
  testIntervalMs?: number;
  /** Where secrets live; `unavailable` means nothing can be saved. */
  secretStore?: SecretsStatus["store"];
  /** Whether new profiles default to the Happy preset (`mongo.happyPreset`). */
  happyPreset?: boolean;
  /** The role chip of a profile by id (the seeded fixtures). */
  roles?: Record<string, RoleChip>;
  localHits?: { host: string; port: number }[];
  ai?: AiCapabilities;
  /** Called when a connection ends (disconnect, delete, save, switch off) so data cursors can be dropped. */
  onClose?: (id: string) => void;
}

export interface SeedProfile {
  id?: string;
  name: string;
  environment: Environment;
  spec: ConnSpec;
  color?: string;
  aiMode?: AiMode;
  tenantLock?: string | null;
  domain?: Domain;
  group?: string;
  favorite?: boolean;
  password?: string;
  maxTimeMs?: number;
}

interface Bundle {
  identity: string;
  password?: string;
  keyPassword?: string;
  sshSecret?: string;
  proxyPassword?: string;
}
interface Rec {
  id: string;
  name: string;
  environment: Environment;
  color: string;
  readOnly: boolean;
  aiMode: AiMode;
  tenantLock: string | null;
  overrideHost: string | null;
  maxTimeMs: number;
  spec: ConnSpec | null;
  legacy: string | null;
  needsReview: boolean;
  bundle: Bundle;
  group: string | null;
  favorite: boolean;
  domain: Domain;
  aiPrefs: { denyFields: string[]; glossary: { from: string; to: string }[] };
  tlsRelax: "none" | "certificates";
  lastUsedMs: number | null;
  rev: number;
}
interface Draft {
  identity: string;
  password?: string;
  keyPassword?: string;
  expires: number;
}
interface Handle {
  kind: "import" | "export";
  expires: number;
  used: boolean;
  fileName: string;
  text?: string;
}

const maskHost = (h: string) => {
  if (LOOPBACK.test(h)) return h;
  const [first, ...rest] = h.split(".");
  return rest.length ? `${first.slice(0, 3)}***.${rest.join(".")}` : `${first.slice(0, 3)}***`;
};

export interface MockEngine {
  api: Omit<MongoCoreIpc, "run" | "window" | "cursorClose" | "cancel">;
  /** Test and mock-world hooks. */
  rec(id: string): Rec | undefined;
  view(id: string): ProfileView | undefined;
  connection(id: string): ConnectionView | undefined;
  isOn(): boolean;
  need(): void;
  addNotice(n: Notice): void;
  /** A tamper simulation: the signature of the profile fails, safety is reset, the user must review and save. */
  tamper(id: string): void;
  /** Queues the file the next native open dialog will return (`null` clears: the user cancels). */
  queueImportFile(text: string | null, fileName?: string): void;
  /** The text the last export wrote. */
  lastExport(): string | undefined;
  /** What the vault currently holds (token count only). */
  vaultSize(): number;
  seed(p: SeedProfile): ProfileView;
  seedLegacy(name: string, uri: string, environment?: Environment): ProfileView;
  trustedKeys(): string[];
}

export function createMockMongoEngine(opts: MockEngineOptions = {}): MockEngine {
  const now = opts.now ?? (() => Date.now());
  const latency = opts.latencyMs ?? 0;
  const interval = opts.testIntervalMs ?? (latency > 0 ? 1000 : 0);
  const store = opts.secretStore ?? "keychain";
  let enabled = opts.enabled ?? false;
  let seq = 0;
  let notices: Notice[] = [];
  let lastTestAt = -Infinity;
  let queuedFile: { text: string; name: string } | null = null;
  let exported: string | undefined;
  const recs = new Map<string, Rec>();
  const connections = new Map<string, ConnectionView>();
  const vault = new Map<string, Draft>();
  const handles = new Map<string, Handle>();
  const trusted = new Set<string>();
  const running = new Map<string, { cancelled: boolean }>();
  const stateListeners = new Set<(s: StudioStatus) => void>();
  const testListeners = new Set<(e: TestEvent) => void>();

  const wait = (ms = latency) => (ms > 0 ? sleep(ms) : Promise.resolve());
  const network = () => opts.network ?? "full";
  const status = (): StudioStatus => ({ compiled: opts.compiled ?? true, enabled, network: network(), connections: [...connections.values()], notices: structuredClone(notices) });
  const emit = () => stateListeners.forEach((l) => l(status()));
  const need = () => void (enabled || fail("mongoDisabled", "MongoDB Studio is off (Settings > Database)"));
  const newId = () => `c${(++seq).toString(16).padStart(12, "0")}`;
  const closeOne = (id: string) => {
    if (connections.delete(id)) opts.onClose?.(id);
  };

  // -- vault -----------------------------------------------------------------------------------------------------------
  function vaultPut(d: Omit<Draft, "expires">): string {
    for (const [k, v] of vault) if (v.expires <= now()) vault.delete(k);
    while (vault.size >= VAULT_CAP) vault.delete(vault.keys().next().value as string);
    const token = `draft-${(++seq).toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
    vault.set(token, { ...d, expires: now() + VAULT_TTL_MS });
    return token;
  }
  /** The entry for a token while it is alive and was typed for this exact destination; anything else is "absent". */
  function vaultPeek(token: string | null | undefined, identity: string): Draft | undefined {
    const d = token ? vault.get(token) : undefined;
    if (!d) return undefined;
    if (d.expires <= now()) return (vault.delete(token as string), undefined);
    return d.identity === identity ? d : undefined;
  }

  // -- derived views ----------------------------------------------------------------------------------------------------
  const legacyLevel = (uri: string): EffectiveLevel => {
    try {
      return levelOfSpec(parseConnection(uri).spec).level;
    } catch {
      return "productionLevel";
    }
  };
  function levelOf(r: Rec): { host: EffectiveLevel; effective: EffectiveLevel } {
    const host: EffectiveLevel = r.spec ? levelOfSpec(r.spec).level : r.legacy ? legacyLevel(r.legacy) : "local";
    const effective: EffectiveLevel = r.environment === "production" ? "productionLevel" : r.overrideHost ? "local" : host;
    return { host, effective };
  }
  function displayHost(r: Rec): string {
    let spec = r.spec;
    if (!spec && r.legacy) {
      try {
        spec = parseConnection(r.legacy).spec;
      } catch {
        spec = null;
      }
    }
    const h = spec?.hosts?.[0];
    if (!h) return "";
    return `${maskHost(h.host)}${h.port ? `:${h.port}` : ""}${spec?.scheme === "srv" ? " (srv)" : ""}`;
  }
  const hasSecret = (r: Rec, kind: SecretKind) => !!r.spec && r.bundle.identity === connIdentity(r.spec) && !!r.bundle[kind];
  function view(r: Rec): ProfileView {
    const lv = levelOf(r);
    const pref = r.spec?.topology?.readPreference ?? "auto";
    const readPreference: ReadPreference = pref === "auto" ? (lv.effective === "productionLevel" ? "secondaryPreferred" : "primaryPreferred") : pref;
    return {
      id: r.id,
      name: r.name,
      environment: r.environment,
      color: r.color,
      readOnly: r.readOnly,
      aiMode: r.aiMode,
      tenantLock: r.tenantLock,
      levelOverride: !!r.overrideHost,
      host: displayHost(r),
      hasUri: !!(r.spec || r.legacy),
      hostLevel: lv.host,
      effectiveLevel: lv.effective,
      readPreference,
      maxTimeMs: r.maxTimeMs,
      spec: r.spec ? structuredClone(r.spec) : null,
      legacyUri: !!r.legacy && !r.spec,
      needsReview: r.needsReview,
      hasPassword: hasSecret(r, "password"),
      hasKeyPassword: hasSecret(r, "keyPassword"),
      hasSshSecret: hasSecret(r, "sshSecret"),
      hasProxyPassword: hasSecret(r, "proxyPassword"),
      group: r.group,
      favorite: r.favorite,
      domain: r.domain,
      aiPrefs: structuredClone(r.aiPrefs),
      tlsRelax: r.tlsRelax,
      lastUsedMs: r.lastUsedMs,
      uriMasked: r.spec ? renderConnectionMasked(r.spec) : "",
    };
  }

  // -- secrets -----------------------------------------------------------------------------------------------------------
  /** Which secrets this destination needs that nobody supplied (stored under the same identity, typed now, or drafted). */
  function missingSecrets(spec: ConnSpec, have: { password?: boolean; sshSecret?: boolean; proxyPassword?: boolean }): SecretKind[] {
    const out: SecretKind[] = [];
    const a = spec.auth ?? {};
    const mech = a.mechanism ?? "default";
    if (a.username && mech !== "none" && mech !== "x509" && !have.password) out.push("password");
    const tun = spec.tunnel ?? { kind: "none" as const };
    if (tun.kind === "ssh" && tun.auth === "password" && !have.sshSecret) out.push("sshSecret");
    if (tun.kind === "socks5" && tun.username && !have.proxyPassword) out.push("proxyPassword");
    return out;
  }
  const needSecret = (kinds: SecretKind[]): never => fail("mongoNeedSecret", `needs:${kinds.join(",")}`);

  function resolveSecrets(spec: ConnSpec, stored: Rec | undefined, input: { password?: string | null; sshSecret?: string | null; proxyPassword?: string | null; draft?: string | null }, session?: SessionSecrets) {
    const identity = connIdentity(spec);
    const bundle = stored && stored.bundle.identity === identity ? stored.bundle : undefined;
    const draft = vaultPeek(input.draft, identity);
    const pick = (typed: string | null | undefined, kind: SecretKind, fromDraft?: string) => (typed ? typed : fromDraft || (session?.[kind] ?? undefined) || bundle?.[kind]);
    return {
      identity,
      password: pick(input.password, "password", draft?.password),
      keyPassword: pick(undefined, "keyPassword", draft?.keyPassword),
      sshSecret: pick(input.sshSecret, "sshSecret"),
      proxyPassword: pick(input.proxyPassword, "proxyPassword"),
    };
  }

  // -- save ---------------------------------------------------------------------------------------------------------------
  const LEVEL_RANK: Record<Environment, number> = { local: 0, sandbox: 1, production: 2 };
  const AI_RANK: Record<AiMode, number> = { off: 0, schemaOnly: 1, schemaEnums: 2 };

  function specOf(input: ProfileInput, old: Rec | undefined): { spec: ConnSpec | null; password?: string; legacy: string | null; warnings: Note[] } {
    if (input.uri && input.spec) return fail("mongoInvalid", "send either a connection string or a spec, not both");
    if (input.uri?.trim()) {
      const p = parseConnection(input.uri);
      return { spec: p.spec, password: p.password, legacy: null, warnings: p.warnings };
    }
    if (input.spec) return { spec: structuredClone(input.spec), legacy: null, warnings: [] };
    if (old) return { spec: old.spec, legacy: old.legacy, warnings: [] };
    return fail("mongoNoUri", "paste a connection string or fill in the connection");
  }

  function save(input: ProfileInput): ProfileView {
    const old = input.id ? recs.get(input.id) : undefined;
    if (input.id && !old) fail("mongoNotFound", "no such connection");
    const name = input.name.trim();
    if (!name || name.length > 64) fail("mongoInvalid", "a connection name is 1 to 64 characters");
    const { spec, password: uriPassword, legacy } = specOf(input, old);
    if (spec) {
      const bad = validateSpec(spec).filter((p) => !p.warning);
      if (bad.length) fail("mongoInvalid", bad.map((p) => `${p.path}:${p.code}`).join(";"));
    }
    const identity = spec ? connIdentity(spec) : "";
    const readOnly = input.readOnly ?? old?.readOnly ?? true;
    const aiMode = input.aiMode ?? old?.aiMode ?? "off";
    const tlsRelax = input.tlsRelax ?? old?.tlsRelax ?? "none";
    const aiPrefs = { denyFields: input.aiPrefs?.denyFields ?? old?.aiPrefs.denyFields ?? [], glossary: input.aiPrefs?.glossary ?? old?.aiPrefs.glossary ?? [] };

    // the typed-host override is bound to the tunnel host, else the first non-loopback host
    const lv = spec ? levelOfSpec(spec) : { level: legacy ? legacyLevel(legacy) : ("local" as EffectiveLevel), host: undefined as string | undefined };
    const tunnelHost = spec?.tunnel?.kind === "ssh" || spec?.tunnel?.kind === "socks5" ? spec.tunnel.host : undefined;
    const expectHost = tunnelHost ?? lv.host ?? old?.spec?.hosts?.[0]?.host;
    let overrideHost = old?.overrideHost ?? null;
    if (input.levelOverrideHost === "") overrideHost = null;
    else if (input.levelOverrideHost) {
      if (input.levelOverrideHost !== expectHost) fail("mongoConfirm", "the typed host does not match the connection");
      overrideHost = input.levelOverrideHost;
    }
    // a changed destination invalidates an override typed for another host
    if (overrideHost && expectHost && overrideHost !== expectHost) overrideHost = null;

    const environment = input.environment;
    const loweringTag = !!old && LEVEL_RANK[environment] < LEVEL_RANK[old.environment];
    const loweringAi = AI_RANK[aiMode] > AI_RANK[old?.aiMode ?? "off"];
    const loweringRo = (old?.readOnly ?? true) && !readOnly;
    const loweringOverride = !!input.levelOverrideHost;
    const relaxOn = tlsRelax === "certificates" && (old?.tlsRelax ?? "none") !== "certificates";
    const removedDeny = (old?.aiPrefs.denyFields ?? []).some((f) => !aiPrefs.denyFields.includes(f));
    if ((loweringTag || loweringAi || loweringRo || loweringOverride || relaxOn || removedDeny) && input.confirm !== name) fail("mongoConfirm", "this lowers a safety setting: type the connection name to confirm");
    if (tlsRelax === "certificates") {
      const effective: EffectiveLevel = environment === "production" ? "productionLevel" : overrideHost ? "local" : lv.level;
      if (effective === "productionLevel") fail("mongoInvalid", "config.tlsRelaxRefused");
    }

    // secrets: bound to the identity they were typed for; a profile that needed review loses all of them
    let bundle: Bundle = { identity };
    const keep = old && !old.needsReview && old.bundle.identity === identity ? old.bundle : undefined;
    if (keep) bundle = { ...keep };
    const draft = vaultPeek(input.draft, identity);
    const setSecret = (kind: SecretKind, typed: string | null | undefined, drafted: string | undefined, keepIt: boolean) => {
      const v = typed === "" ? "" : typed || drafted;
      if (v === "") delete bundle[kind];
      else if (v) bundle[kind] = v;
      if (!keepIt || store === "unavailable") delete bundle[kind];
    };
    const tun = spec?.tunnel ?? { kind: "none" as const };
    setSecret("password", input.password ?? uriPassword, draft?.password, spec?.auth?.savePassword !== false);
    setSecret("keyPassword", input.keyPassword, draft?.keyPassword, spec?.tls?.saveKeyPassword === true);
    setSecret("sshSecret", input.sshSecret, undefined, tun.kind === "ssh" && tun.saveSecret !== false);
    setSecret("proxyPassword", input.proxyPassword, undefined, tun.kind === "socks5" && tun.savePassword !== false);
    if (input.draft) vault.delete(input.draft);

    const group = input.group === "" ? null : input.group != null ? input.group.slice(0, 40) : (old?.group ?? null);
    const rec: Rec = {
      id: old?.id ?? newId(),
      name,
      environment,
      color: input.color ?? old?.color ?? "",
      readOnly,
      aiMode,
      tenantLock: input.tenantLock == null ? (old?.tenantLock ?? null) : input.tenantLock.trim() || null,
      overrideHost,
      maxTimeMs: input.maxTimeMs ?? old?.maxTimeMs ?? 15_000,
      spec,
      legacy: spec ? null : legacy,
      needsReview: false,
      bundle,
      group,
      favorite: input.favorite ?? old?.favorite ?? false,
      domain: input.domain ?? old?.domain ?? (opts.happyPreset ? "happy" : "generic"),
      aiPrefs: structuredClone(aiPrefs),
      tlsRelax,
      lastUsedMs: old?.lastUsedMs ?? null,
      rev: (old?.rev ?? 0) + 1,
    };
    recs.set(rec.id, rec);
    closeOne(rec.id);
    return view(rec);
  }

  // -- connect --------------------------------------------------------------------------------------------------------
  function jail(spec: ConnSpec | null) {
    if (network() === "refused") fail("readOnly", "network access is refused in this mode");
    if (network() === "loopbackOnly" && spec && levelOfSpec(spec).level === "productionLevel") fail("testJail", "only loopback hosts are allowed in this mode");
  }

  function roleFor(id: string | undefined, spec: ConnSpec | null, level: EffectiveLevel): RoleChip {
    if (id && opts.roles?.[id]) return opts.roles[id];
    const user = spec?.auth?.username ?? "";
    const mech = spec?.auth?.mechanism ?? "default";
    if (level === "local" && (mech === "none" || !user)) return { role: "canWrite", actions: ["no access control: every action is allowed"], noAuth: true };
    if (/readonly|reader/i.test(user)) return { role: "readOnly" };
    if (!id && level === "productionLevel") return { role: "unknown", reason: "the server did not return privileges (Atlas or a restricted user)" };
    return { role: "readOnly" };
  }

  function connectionOf(id: string, name: string, spec: ConnSpec | null, rec: Rec | undefined, env: Environment, level: EffectiveLevel): ConnectionView {
    const local = level === "local";
    const role = roleFor(rec?.id, spec, level);
    const tls = spec ? spec.tls?.mode === "on" || (spec.tls?.mode !== "off" && (spec.scheme === "srv" || !local)) : !local;
    const pref = spec?.topology?.readPreference ?? "auto";
    return {
      id,
      name,
      serverVersion: local ? "6.0.28" : "7.0.14",
      topology: spec?.topology?.replicaSet || spec?.scheme === "srv" || !local ? "replicaSet" : "standalone",
      pingMs: local ? 38 : 142,
      effectiveLevel: level,
      environment: env,
      readOnly: rec?.readOnly ?? true,
      readPreference: pref === "auto" ? (level === "productionLevel" ? "secondaryPreferred" : "primaryPreferred") : pref,
      role,
      roleElevated: role.role !== "readOnly",
      tls,
      tunnel: spec?.tunnel?.kind === "ssh" ? "up" : null,
      tlsRelax: rec?.tlsRelax ?? "none",
    };
  }

  async function connect(id: string, secrets?: SessionSecrets): Promise<ConnectionView> {
    need();
    const r = recs.get(id) ?? fail("mongoNotFound", "no such connection");
    if (r.needsReview) fail("mongoNeedsReview", "Connection settings were changed outside the IDE. Review and save them again.");
    if (!r.spec && !r.legacy) fail("mongoNoUri", "this connection has no saved connection string");
    jail(r.spec);
    if (r.spec) {
      const got = resolveSecrets(r.spec, r, {}, secrets);
      const missing = missingSecrets(r.spec, { password: !!got.password, sshSecret: !!got.sshSecret, proxyPassword: !!got.proxyPassword });
      if (missing.length) needSecret(missing);
      const code = injectedCode([...(r.spec.hosts ?? []).map((h) => h.host), r.spec.auth?.username, r.spec.tunnel?.kind === "ssh" ? r.spec.tunnel.host : undefined]);
      if (code) {
        await wait();
        fail("mongoConnect", MOCK_DIAGNOSES[code].detail);
      }
    }
    await wait(latency * 2);
    const level = levelOf(r).effective;
    const v = connectionOf(r.id, r.name, r.spec, r, r.environment, level);
    r.lastUsedMs = now();
    connections.set(id, v);
    emit();
    return structuredClone(v);
  }

  // -- test ----------------------------------------------------------------------------------------------------------------
  const emitStep = (testId: string | undefined, step: TestStep) => testId && testListeners.forEach((l) => l({ testId, step: { ...step } }));

  async function test(input: ProfileInput, testId?: string): Promise<TestReport> {
    need();
    const old = input.id ? recs.get(input.id) : undefined;
    if (old?.needsReview) fail("mongoNeedsReview", "Connection settings were changed outside the IDE. Review and save them again.");
    if (testId && running.has(testId)) fail("mongoBusy", "a test is already running");
    if (now() - lastTestAt < interval) fail("mongoBusy", "wait a second between tests");

    let spec: ConnSpec | null;
    let uriPassword: string | undefined;
    try {
      const s = specOf(input, old);
      spec = s.spec;
      uriPassword = s.password;
      if (!spec && s.legacy) {
        const p = parseConnection(s.legacy);
        spec = p.spec;
        uriPassword = p.password;
      }
    } catch (e) {
      if ((e as { code?: string }).code === "mongoNoUri") return { ok: false, elapsedMs: 1, error: "paste a connection string", errorClass: "other" };
      return { ok: false, elapsedMs: 1, error: (e as { message?: string }).message ?? "failed", errorClass: "other" };
    }
    if (!spec) return { ok: false, elapsedMs: 1, error: "paste a connection string", errorClass: "other" };
    jail(spec);

    const lv = levelOfSpec(spec);
    const tlsRelax = input.tlsRelax ?? old?.tlsRelax ?? "none";
    const overridden = !!old?.overrideHost && !!old.spec && connIdentity(old.spec) === connIdentity(spec);
    const level: EffectiveLevel = input.environment === "production" ? "productionLevel" : overridden ? "local" : lv.level;
    if (tlsRelax === "certificates" && (old?.tlsRelax ?? "none") !== "certificates" && input.confirm !== input.name.trim()) fail("mongoConfirm", "turning off certificate checks needs the typed connection name");

    // identity rule: secrets typed for another destination do not count
    const got = resolveSecrets(spec, old, { password: input.password ?? uriPassword, sshSecret: input.sshSecret, proxyPassword: input.proxyPassword, draft: input.draft });
    const missing = missingSecrets(spec, { password: !!got.password, sshSecret: !!got.sshSecret, proxyPassword: !!got.proxyPassword });
    if (missing.length) needSecret(missing);

    const id = testId ?? `t${++seq}`;
    running.set(id, { cancelled: false });
    lastTestAt = now();
    try {
      return await runPipeline(id, testId, input, spec, level, tlsRelax, old);
    } finally {
      running.delete(id);
    }
  }

  async function runPipeline(id: string, testId: string | undefined, input: ProfileInput, spec: ConnSpec, level: EffectiveLevel, tlsRelax: "none" | "certificates", old: Rec | undefined): Promise<TestReport> {
    const tun = spec.tunnel ?? { kind: "none" as const };
    const ssh = tun.kind === "ssh" ? tun : undefined;
    const proxied = tun.kind !== "none";
    const order: StepId[] = ["config", ...(proxied ? (["tunnel"] as StepId[]) : []), "dns", "connect", "tls", "auth", "permissions"];
    const states = new Map<StepId, TestStep>(order.map((s) => [s, { id: s, state: "pending" as StepState, ms: 0 }]));
    const steps = () => order.map((s) => ({ ...states.get(s)! }));
    const set = (s: StepId, state: StepState, ms = 0, note?: string) => {
      const step: TestStep = { id: s, state, ms, ...(note ? { note } : {}) };
      states.set(s, step);
      emitStep(testId, step);
    };

    let code = injectedCode([...(spec.hosts ?? []).map((h) => h.host), spec.auth?.username, ssh?.host, input.uri]);
    // a bastion whose key was never trusted fails the way ssh does
    const bastion = ssh ? { host: ssh.host, port: ssh.port ?? 22 } : undefined;
    let keyStatus: HostKeyView["status"] = "known";
    if (ssh) {
      try {
        keyStatus = hostKeyOf(ssh).status;
      } catch {
        code ??= "tunnel.hostKeyUnscannable";
      }
    }
    if (!code && bastion && keyStatus === "unknown") code = "tunnel.hostKeyUnknown";
    if (!code && bastion && keyStatus === "changed") code = "tunnel.hostKeyChanged";
    if (!code && tlsRelax === "certificates" && level === "productionLevel") code = "config.tlsRelaxRefused";
    const problems = validateSpec(spec).filter((p) => !p.warning);
    if (!code && problems.length) code = problems.some((p) => p.code === "config.plainRemote") ? "config.plainRemote" : "config.invalid";

    // members of a replica set behind a tunnel must be allowed (the relay refuses everything else)
    const seeds = (spec.hosts ?? []).map((h) => `${h.host.toLowerCase()}:${h.port ?? 27017}`);
    let members = seeds;
    let refused: string[] = [];
    if (spec.topology?.replicaSet || spec.scheme === "srv") {
      const first = spec.hosts?.[0]?.host ?? "db";
      const [label, ...rest] = first.split(".");
      const dom = rest.length ? `.${rest.join(".")}` : "";
      members = [...new Set([...seeds, `${label}-b${dom}:27017`.toLowerCase(), `${label}-c${dom}:27017`.toLowerCase()])];
    }
    if (ssh && !code && spec.scheme !== "srv") {
      const allowed = new Set([...seeds, ...(ssh.allowedHosts ?? []).map((a) => `${a.host.toLowerCase()}:${a.port}`)]);
      refused = members.filter((m) => !allowed.has(m));
      if (refused.length) code = "tunnel.notAllowed";
    }

    const def = code ? MOCK_DIAGNOSES[code] : undefined;
    const failAt: StepId | undefined = def ? (order.includes(def.step) ? def.step : def.class === "tunnel" ? "tunnel" : "connect") : undefined;
    const soft = def?.class === "authz";
    let total = 0;
    for (const s of order) {
      if (running.get(id)?.cancelled) {
        set(s, "skipped");
        continue;
      }
      if ((s === "dns" || s === "connect") && proxied && failAt !== s && !(s === "dns" && spec.scheme === "srv")) {
        set(s, "skipped");
        continue;
      }
      if (failAt && !soft && order.indexOf(s) > order.indexOf(failAt)) {
        set(s, "skipped");
        continue;
      }
      set(s, "running");
      await wait();
      const ms = s === "config" ? 1 : s === "tunnel" ? 180 : s === "dns" ? 12 : s === "connect" ? 25 : s === "tls" ? 40 : s === "auth" ? 60 : 20;
      total += ms;
      if (failAt === s) set(s, soft ? "warn" : "failed", ms);
      else if (s === "tls" && (spec.tls?.mode === "off" || (spec.tls?.mode !== "on" && spec.scheme !== "srv" && level === "local"))) set(s, "skipped", 0, "off");
      else set(s, "ok", ms);
    }
    if (running.get(id)?.cancelled) return { ok: false, elapsedMs: total, error: "cancelled", errorClass: "other", steps: steps(), warnings: [] };

    const diagnosis: Diagnosis | null = def ? { class: def.class, code: code!, params: diagParams(code!, spec, bastion, refused), detail: def.detail, retryable: def.retryable ?? true } : null;
    const hostKey = ssh && (code === "tunnel.hostKeyUnknown" || code === "tunnel.hostKeyChanged") ? safeHostKey(ssh) : null;

    if (def && !soft) return { ok: false, elapsedMs: total, error: def.detail, errorClass: def.class, steps: steps(), diagnosis, hostKey, refused, members: [], warnings: [] };
    const conn = connectionOf(input.id ?? "draft", input.name, spec, old, input.environment, level);
    const warnings: string[] = [];
    const reason = levelOfSpec(spec).reason;
    if (spec.tls?.mode === "off" && (reason === "remoteHost" || reason === "srv" || reason === "tunnel")) warnings.push("plainTextRemote");
    if (tlsRelax === "certificates") warnings.push("certChecksRelaxed");
    if (conn.roleElevated) warnings.push("writerAccount");
    return { ok: true, elapsedMs: total, connection: conn, members, refused: [], steps: steps(), diagnosis, hostKey: null, warnings };
  }

  function safeHostKey(ssh: SshSpec): HostKeyView | null {
    try {
      return hostKeyOf(ssh);
    } catch {
      return null;
    }
  }

  function diagParams(code: string, spec: ConnSpec, bastion: { host: string; port: number } | undefined, refused: string[]): [string, string][] {
    if (code === "tunnel.notAllowed") {
      // a forced scenario has no refused member: name the first database host instead of an empty one
      const named = refused[0] ?? (spec.hosts?.[0] ? `${spec.hosts[0].host}:${spec.hosts[0].port ?? 27017}` : "");
      return [["host", named]];
    }
    if (code.startsWith("tunnel.") && bastion) return [["host", bastion.host], ["port", String(bastion.port)]];
    const h = spec.hosts?.[0];
    return h ? [["host", h.host], ...(h.port ? ([["port", String(h.port)]] as [string, string][]) : [])] : [];
  }

  // -- ssh host keys -------------------------------------------------------------------------------------------------------
  function hostKeyOf(ssh: SshSpec): HostKeyView {
    const port = ssh.port ?? 22;
    if (/inject[-_]?tunnel[-_.]?hostkeyunscannable/i.test(ssh.host)) fail("mongoHostKey", "tunnel.hostKeyUnscannable");
    const fingerprint = fingerprintOf(ssh.host, port);
    const changed = /inject[-_]?tunnel[-_.]?hostkeychanged/i.test(ssh.host);
    const known = trusted.has(`${ssh.host.toLowerCase()}:${port}:${fingerprint}`);
    return { host: ssh.host, port, keyType: "ssh-ed25519", fingerprint: changed ? fingerprintOf(`${ssh.host}-new`, port) : fingerprint, status: changed ? "changed" : known ? "known" : "unknown" };
  }

  // -- import / export ------------------------------------------------------------------------------------------------------
  function redeem(token: string, kind: "import" | "export", consume: boolean): Handle {
    const h = handles.get(token);
    if (!h || h.used || h.kind !== kind || h.expires <= now()) return fail("mongoHandle", "pick the file again");
    if (consume) h.used = true;
    return h;
  }

  interface Candidate {
    name: string;
    environment: Environment;
    spec: ConnSpec;
    color?: string;
    group?: string | null;
    favorite?: boolean;
    domain?: Domain;
    tenantLock?: string | null;
    aiPrefs?: Rec["aiPrefs"];
    password?: string;
    warnings: Note[];
  }

  function candidates(h: Handle): Candidate[] {
    const text = h.text ?? "";
    if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) fail("mongoImport", "line 0: tooLarge");
    const trimmed = text.trim();
    const out: Candidate[] = [];
    if (trimmed.startsWith("{")) {
      let doc: { format?: string; version?: number; profiles?: Record<string, unknown>[] };
      try {
        doc = JSON.parse(trimmed);
      } catch (e) {
        const line = text.slice(0, Number(/position (\d+)/.exec(String((e as Error).message))?.[1] ?? 0)).split("\n").length;
        return fail("mongoImport", `line ${line}: syntax`);
      }
      if (doc.format !== "intely-mongo-profiles" || doc.version !== 1) fail("mongoImport", "line 1: format");
      const list = doc.profiles ?? [];
      if (!Array.isArray(list) || list.length > 200) fail("mongoImport", "line 1: tooMany");
      const allowed = new Set(["name", "color", "environment", "group", "favorite", "domain", "tenantLock", "aiPrefs", "spec", "secrets"]);
      list.forEach((p, i) => {
        if (Object.keys(p).some((k) => !allowed.has(k))) fail("mongoImport", `profile ${i + 1}: unknownField`);
        const spec = (p.spec ?? null) as ConnSpec | null;
        if (!spec || validateSpec(spec).some((x) => !x.warning)) fail("mongoImport", `profile ${i + 1}: invalid`);
        const warnings: Note[] = [];
        let domain: Domain = p.domain === "happy" ? "happy" : "generic";
        if (domain === "happy" && !opts.happyPreset) (domain = "generic", warnings.push({ code: "domainHappyOff" }));
        out.push({
          name: String(p.name ?? `Imported ${i + 1}`).slice(0, 64),
          environment: (["local", "sandbox", "production"] as const).includes(p.environment as Environment) ? (p.environment as Environment) : "production",
          spec: spec as ConnSpec,
          color: typeof p.color === "string" ? p.color : undefined,
          group: typeof p.group === "string" ? p.group : null,
          favorite: p.favorite === true,
          domain,
          tenantLock: typeof p.tenantLock === "string" ? p.tenantLock : null,
          aiPrefs: (p.aiPrefs as Rec["aiPrefs"]) ?? undefined,
          warnings,
        });
      });
    } else {
      let count = 0;
      text.split(/\r?\n/).forEach((raw, i) => {
        const line = raw.trim();
        if (!line || line.startsWith("#")) return;
        if (!/^mongodb(\+srv)?:\/\//.test(line)) fail("mongoImport", `line ${i + 1}: notUri`);
        if (++count > 50) fail("mongoImport", `line ${i + 1}: tooMany`);
        let parsed: ParsedConnection;
        try {
          parsed = parseConnection(line);
        } catch {
          return fail("mongoImport", `line ${i + 1}: invalid`);
        }
        out.push({ name: parsed.spec.hosts?.[0]?.host ?? `Imported ${count}`, environment: "production", spec: parsed.spec, password: parsed.password, warnings: parsed.warnings });
      });
    }
    return out;
  }

  const endpointsOf = (spec: ConnSpec) => {
    const e = (spec.hosts ?? []).map((h) => `${h.host}:${h.port ?? 27017}`);
    const t = spec.tunnel;
    if (t?.kind === "ssh") e.push(`${t.host}:${t.port ?? 22}`);
    if (t?.kind === "socks5") e.push(`${t.host}:${t.port}`);
    return e;
  };
  const needsConfirm = (spec: ConnSpec) => (spec.tunnel?.kind ?? "none") !== "none" || spec.auth?.mechanism === "plain" || spec.tls?.mode === "off" || levelOfSpec(spec).level === "productionLevel";

  // -- the surface ------------------------------------------------------------------------------------------------------------
  const api: MockEngine["api"] = {
    status: async () => status(),
    async setEnabled(on) {
      enabled = on;
      if (!on) {
        for (const id of [...connections.keys()]) closeOne(id);
        vault.clear();
        handles.clear();
        for (const r of running.values()) r.cancelled = true;
      }
      emit();
      return status();
    },
    async parseLiteral(text) {
      if (!text.trim() || text.split("{").length !== text.split("}").length) throw err("mongoParse", "unbalanced braces");
      return text;
    },
    async profiles() {
      return [...recs.values()].map(view);
    },
    async profileSave(input) {
      const p = save(input);
      emit();
      return p;
    },
    async profileDelete(id) {
      if (!recs.delete(id)) fail("mongoNotFound", "no such connection");
      closeOne(id);
      emit();
    },
    async profileDuplicate(id) {
      const r = recs.get(id) ?? fail("mongoNotFound", "no such connection");
      const copy: Rec = { ...structuredClone(r), id: newId(), name: `${r.name} copy`, bundle: { identity: "" }, lastUsedMs: null, rev: 1 };
      recs.set(copy.id, copy);
      emit();
      return view(copy);
    },
    async dismissNotices() {
      notices = [];
      emit();
    },
    async uriParse(uri) {
      need();
      const p = parseConnection(uri);
      const draft = p.password ? vaultPut({ identity: connIdentity(p.spec), password: p.password }) : null;
      const out: UriParse = { spec: p.spec, hasPassword: !!p.password, hasKeyPassword: false, draft, warnings: p.warnings, unsupported: p.unsupported };
      return out;
    },
    async uriRender(spec) {
      need();
      return renderConnectionMasked(spec);
    },
    async draftDiscard(draft) {
      need();
      vault.delete(draft);
    },
    async profileConvert(id): Promise<ProfileDraft> {
      need();
      const r = recs.get(id) ?? fail("mongoNotFound", "no such connection");
      if (!r.legacy) fail("mongoInvalid", "this connection is already stored as fields");
      const p = parseConnection(r.legacy);
      const draft = p.password ? vaultPut({ identity: connIdentity(p.spec), password: p.password }) : null;
      const input: ProfileInput = { id: r.id, name: r.name, environment: r.environment, color: r.color || null, spec: p.spec, group: r.group, favorite: r.favorite, domain: r.domain };
      return { input, draft, dropped: [...p.warnings.filter((w) => w.code !== "ignoredReadOnly"), ...p.unsupported] };
    },
    async profileMeta(id, meta: ProfileMeta) {
      const r = recs.get(id) ?? fail("mongoNotFound", "no such connection");
      if (meta.group != null) r.group = meta.group === "" ? null : meta.group.slice(0, 40);
      if (meta.favorite != null) r.favorite = meta.favorite;
      if (meta.color != null) r.color = meta.color;
      emit();
      return view(r);
    },
    async profileSecret(id, kind, value) {
      const r = recs.get(id) ?? fail("mongoNotFound", "no such connection");
      if (!r.spec) fail("mongoInvalid", "convert this connection to fields first");
      if (store === "unavailable") fail("mongoInvalid", "secrets cannot be stored on this system");
      const identity = connIdentity(r.spec);
      if (r.bundle.identity !== identity) r.bundle = { identity };
      if (value) r.bundle[kind] = value;
      else delete r.bundle[kind];
      emit();
      return view(r);
    },
    async secretsStatus(id): Promise<SecretsStatus> {
      const r = id ? recs.get(id) : undefined;
      return {
        store,
        hasPassword: !!r && hasSecret(r, "password"),
        hasKeyPassword: !!r && hasSecret(r, "keyPassword"),
        hasSshSecret: !!r && hasSecret(r, "sshSecret"),
        hasProxyPassword: !!r && hasSecret(r, "proxyPassword"),
        identityMatches: !r || !r.spec || !r.bundle.identity || r.bundle.identity === connIdentity(r.spec),
      };
    },
    connect: (id, secrets) => connect(id, secrets),
    async disconnect(id) {
      closeOne(id);
      emit();
    },
    test: (input, testId) => test(input, testId),
    async testCancel(testId) {
      const r = running.get(testId);
      if (!r) return false;
      r.cancelled = true;
      return true;
    },
    async sshHostkey(ssh) {
      need();
      jail(null);
      await wait();
      return hostKeyOf(ssh);
    },
    async sshTrust(host, port, fingerprint) {
      need();
      const hk = hostKeyOf({ host, port, user: "x" });
      if (hk.status === "changed") fail("mongoHostKey", "tunnel.hostKeyChanged");
      if (hk.fingerprint !== fingerprint) fail("mongoHostKey", "the fingerprint differs from a fresh scan");
      trusted.add(`${host.toLowerCase()}:${port}:${fingerprint}`);
    },
    async sshForget(host, port, typedHost) {
      need();
      if (typedHost !== host) fail("mongoConfirm", "type the host name to forget its saved key");
      const old = [...trusted].filter((k) => k.startsWith(`${host.toLowerCase()}:${port}:`));
      old.forEach((k) => trusted.delete(k));
      return { old: old.map((k) => k.split(":").slice(2).join(":")), current: [] };
    },
    async dialogOpen() {
      need();
      if (!queuedFile) return null;
      const token = `handle-${(++seq).toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
      handles.set(token, { kind: "import", expires: now() + HANDLE_TTL_MS, used: false, fileName: queuedFile.name, text: queuedFile.text });
      const out: DialogHandle = { token, kind: "import", fileName: queuedFile.name };
      return out;
    },
    async dialogSave(_kind, suggestedName) {
      need();
      const token = `handle-${(++seq).toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
      const fileName = suggestedName || "intely-mongo-profiles.json";
      handles.set(token, { kind: "export", expires: now() + HANDLE_TTL_MS, used: false, fileName });
      const out: DialogHandle = { token, kind: "export", fileName };
      return out;
    },
    async profilesExport(ids, o: ExportOptions, handle) {
      need();
      redeem(handle, "export", true);
      const profiles = ids.map((id) => recs.get(id) ?? fail("mongoNotFound", "no such connection")).map((r) => {
        const spec = structuredClone(r.spec ?? (r.legacy ? parseConnection(r.legacy).spec : ({} as ConnSpec)));
        if (!o.includePaths) {
          if (spec.tls) (spec.tls.caFile = null, (spec.tls.clientCertFile = null));
          if (spec.tunnel?.kind === "ssh") spec.tunnel.keyFile = null;
        }
        if (!o.includeTunnel) spec.tunnel = { kind: "none" };
        const needs = missingSecrets(spec, {});
        return {
          name: r.name, color: r.color || null, environment: r.environment, group: r.group, favorite: r.favorite, domain: r.domain, tenantLock: r.tenantLock, aiPrefs: r.aiPrefs, spec,
          secrets: { password: needs.includes("password") ? "needed" : "none", keyPassword: spec.tls?.saveKeyPassword ? "needed" : "none", sshSecret: needs.includes("sshSecret") ? "needed" : "none", proxyPassword: needs.includes("proxyPassword") ? "needed" : "none" },
        };
      });
      exported = JSON.stringify({ format: "intely-mongo-profiles", version: 1, profiles }, null, 2);
      return { count: profiles.length };
    },
    async profilesImportPreview(handle): Promise<ImportPreview> {
      need();
      const h = redeem(handle, "import", false);
      const items: ImportItem[] = candidates(h).map((c) => ({ name: c.name, warnings: c.warnings.filter((w) => w.code !== "ignoredReadOnly"), endpoints: endpointsOf(c.spec), needsConfirm: needsConfirm(c.spec) }));
      return { items, notes: [] };
    },
    async profilesImport(handle, selected): Promise<ImportReport> {
      need();
      const h = redeem(handle, "import", true);
      const all = candidates(h);
      let imported = 0;
      for (const i of selected) {
        const c = all[i];
        if (!c) continue;
        let name = c.name;
        for (let n = 2; [...recs.values()].some((r) => r.name === name); n++) name = `${c.name} (${n})`;
        const tunnelled = (c.spec.tunnel?.kind ?? "none") !== "none";
        const env: Environment = tunnelled && c.environment !== "production" ? "production" : c.environment;
        const spec = structuredClone(c.spec);
        const id = newId();
        const identity = connIdentity(spec);
        recs.set(id, {
          id, name, environment: env, color: c.color ?? "", readOnly: true, aiMode: "off", tenantLock: c.tenantLock ?? null, overrideHost: null, maxTimeMs: 15_000, spec, legacy: null, needsReview: false,
          bundle: c.password && store !== "unavailable" ? { identity, password: c.password } : { identity },
          group: c.group ?? null, favorite: c.favorite ?? false, domain: c.domain ?? "generic", aiPrefs: c.aiPrefs ?? { denyFields: [], glossary: [] }, tlsRelax: "none", lastUsedMs: null, rev: 1,
        });
        imported++;
      }
      emit();
      return { imported, skipped: selected.length - imported, notes: [] };
    },
    async detectLocal() {
      need();
      jail(null);
      return structuredClone(opts.localHits ?? []);
    },
    async aiCapabilities() {
      need();
      return opts.ai ?? { node: true, claudeCli: true, script: true };
    },
    async resetAll(typedPhrase, o) {
      if (!typedPhrase.trim()) fail("mongoConfirm", "type the phrase to confirm");
      const profiles = recs.size;
      const secrets = [...recs.values()].filter((r) => Object.keys(r.bundle).some((k) => k !== "identity")).length;
      for (const id of [...connections.keys()]) closeOne(id);
      recs.clear();
      vault.clear();
      handles.clear();
      const files = trusted.size ? 2 : 1;
      trusted.clear();
      notices = [];
      emit();
      return { profiles, secrets, files: files + (o.auditToo ? 1 : 0) };
    },
    onState(cb) {
      stateListeners.add(cb);
      return () => void stateListeners.delete(cb);
    },
    onTest(cb) {
      testListeners.add(cb);
      return () => void testListeners.delete(cb);
    },
  };

  const seedRec = (p: SeedProfile): Rec => {
    const spec = structuredClone(p.spec);
    const identity = connIdentity(spec);
    return {
      id: p.id ?? newId(), name: p.name, environment: p.environment, color: p.color ?? "", readOnly: true, aiMode: p.aiMode ?? "off", tenantLock: p.tenantLock ?? null, overrideHost: null,
      maxTimeMs: p.maxTimeMs ?? 15_000, spec, legacy: null, needsReview: false, bundle: p.password ? { identity, password: p.password } : { identity },
      group: p.group ?? null, favorite: p.favorite ?? false, domain: p.domain ?? (opts.happyPreset ? "happy" : "generic"), aiPrefs: { denyFields: [], glossary: [] }, tlsRelax: "none", lastUsedMs: null, rev: 1,
    };
  };

  return {
    api,
    rec: (id) => recs.get(id),
    view: (id) => (recs.has(id) ? view(recs.get(id)!) : undefined),
    connection: (id) => connections.get(id),
    isOn: () => enabled,
    need,
    addNotice(n) {
      notices = [...notices, n];
      emit();
    },
    tamper(id) {
      const r = recs.get(id) ?? fail("mongoNotFound", "no such connection");
      Object.assign(r, { needsReview: true, readOnly: true, aiMode: "off", environment: "production" });
      closeOne(id);
      notices = [...notices, { profileId: id, message: `Connection settings of ${r.name} were changed outside the IDE. Review and save them again.` }];
      emit();
    },
    queueImportFile(text, fileName = "profiles.json") {
      queuedFile = text === null ? null : { text, name: fileName };
    },
    lastExport: () => exported,
    vaultSize: () => vault.size,
    seed(p) {
      const r = seedRec(p);
      recs.set(r.id, r);
      return view(r);
    },
    seedLegacy(name, uri, environment = "local") {
      const r = seedRec({ name, environment, spec: { hosts: [{ host: "x" }] } });
      Object.assign(r, { spec: null, legacy: uri, bundle: { identity: "" } });
      recs.set(r.id, r);
      return view(r);
    },
    trustedKeys: () => [...trusted],
  };
}

// --- the small data-backed core (vitest and `createMockMongoCore` users) ----------------------------------------------------

/** A deterministic generator (LCG) so the grid has the same rows in every run. */
function order(i: number): string {
  let s = (i + 1) * 2654435761;
  const next = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const status = STATUSES[Math.floor(next() * STATUSES.length)];
  const created = 1_780_000_000_000 + Math.floor(next() * 9_000_000_000);
  const oid = (1_780_000_000 + i).toString(16).padStart(8, "0") + i.toString(16).padStart(16, "0");
  return JSON.stringify({
    _id: { $oid: oid },
    number: { $numberInt: String(10_000 + i) },
    status,
    total: { $numberDouble: (Math.round(next() * 5_000_000) / 100).toFixed(2) },
    items: [{ sku: `P-${Math.floor(next() * 200)}`, qty: { $numberInt: String(1 + Math.floor(next() * 4)) } }],
    createdAt: { $date: { $numberLong: String(created) } },
    note: next() < 0.1 ? "Rush delivery" : null,
  });
}

function matches(doc: string, filter: string): boolean {
  const eq = [...filter.matchAll(/([A-Za-z_][\w.]*)\s*:\s*['"]([^'"]+)['"]/g)];
  if (!eq.length) return true;
  const d = JSON.parse(doc) as Record<string, unknown>;
  return eq.every(([, k, v]) => d[k] === v);
}

const WRITE_VERBS = /^(insert|update|delete|drop|create|rename|bulk|find[A-Z]\w*And|run|eval)/;

export type MockMongoCoreOptions = MockEngineOptions;

export function createMockMongoCore(opts: MockMongoCoreOptions = {}): MongoCoreIpc & { engine: MockEngine } {
  const cursors = new Map<string, { docs: string[]; cmd: ReadCommand; truncated: boolean }>();
  const engine = createMockMongoEngine({
    ...opts,
    onClose: (id) => {
      for (const tab of cursors.keys()) if (tab.startsWith(id)) cursors.delete(tab);
      opts.onClose?.(id);
    },
  });
  const setEnabled = engine.api.setEnabled;

  function result(tab: string, st: { docs: string[]; cmd: ReadCommand; truncated: boolean }, offset: number, count: number): WindowView {
    const docs = st.docs.slice(offset, offset + count);
    return { tab, docs, offset, loaded: st.docs.length, truncated: st.truncated, hasMore: offset + docs.length < st.docs.length, bytes: docs.join("").length, elapsedMs: 4, secondaryOk: false };
  }

  return {
    ...engine.api,
    engine,
    async setEnabled(on) {
      if (!on) cursors.clear();
      return setEnabled(on);
    },
    async run(req) {
      engine.need();
      if (!engine.connection(req.connection)) throw err("mongoNotConnected", "connect first");
      const cmd = req.command as { cmd: string } & Record<string, unknown>;
      if (WRITE_VERBS.test(cmd.cmd)) throw err("mongoInvalid", "unknown command");
      let docs: string[] = [];
      let truncated = false;
      switch (cmd.cmd) {
        case "find": {
          const all = Array.from({ length: TOTAL }, (_, i) => order(i)).filter((d) => matches(d, String(cmd.filter ?? "")));
          const skip = Number(cmd.skip ?? 0);
          const limit = cmd.limit ? Number(cmd.limit) : undefined;
          const rest = all.slice(skip);
          const cap = Math.min(limit ?? MAX_DOCS, MAX_DOCS);
          docs = rest.slice(0, cap);
          truncated = limit === undefined || limit > MAX_DOCS ? rest.length > cap : false;
          break;
        }
        case "listDatabases":
          docs = [JSON.stringify({ name: "intely_test_shop" })];
          break;
        case "listCollections":
          docs = ["orders", "customers", "products"].map((name) => JSON.stringify({ name }));
          break;
        case "count":
          docs = [JSON.stringify({ count: Array.from({ length: TOTAL }, (_, i) => order(i)).filter((d) => matches(d, String(cmd.filter ?? ""))).length, capped: false })];
          break;
        default:
          docs = [];
      }
      const st = { docs, cmd: req.command, truncated };
      cursors.set(req.tab, st);
      return result(req.tab, st, 0, req.pageSize ?? 50);
    },
    async window(tab, offset, count) {
      engine.need();
      const st = cursors.get(tab);
      if (!st) throw err("mongoNotFound", "no cursor in this tab: run a query first");
      return result(tab, st, offset, count);
    },
    async cursorClose(tab) {
      cursors.delete(tab);
    },
    async cancel(tab): Promise<CancelView> {
      return { cancelled: cursors.has(tab), killed: false };
    },
  };
}
