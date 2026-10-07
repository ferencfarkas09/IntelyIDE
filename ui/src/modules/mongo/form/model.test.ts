import { describe, expect, it } from "vitest";
import type { ConnSpec, ProfileView, UriParse } from "../../../ipc/mongo";
import { connIdentity } from "../logic";
import {
  applyParsed,
  blocking,
  cleanSpec,
  confirmed,
  effectiveLevelOf,
  groupNotes,
  initialState,
  loweringReasons,
  NO_SECRETS,
  normalizeSpec,
  overrideHostOf,
  overrideState,
  parseAllowed,
  problemsOf,
  relaxAllowed,
  secretsWillBeDropped,
  slotsInUse,
  tabOfPath,
  toInput,
  withScheme,
  wantsPassword,
  type FormState,
} from "./model";

const local: ConnSpec = { scheme: "standard", hosts: [{ host: "127.0.0.1", port: 27017 }], auth: { mechanism: "none" }, tls: { mode: "auto" }, tunnel: { kind: "none" } };
const remote: ConnSpec = { scheme: "standard", hosts: [{ host: "db.example.com", port: 27017 }], auth: { mechanism: "default", username: "reader", savePassword: true }, tls: { mode: "auto" }, tunnel: { kind: "none" } };
const state = (spec: ConnSpec = remote, o: Partial<FormState> = {}): FormState => ({ ...initialState({ defaultAi: "off", initial: { spec } }), name: "Acme", ...o });

const view = (o: Partial<ProfileView> = {}): ProfileView =>
  ({
    id: "p1", name: "Acme", environment: "production", color: "#e5484d", readOnly: true, aiMode: "off", tenantLock: null, levelOverride: false, host: "db.example.com", hasUri: true,
    hostLevel: "productionLevel", effectiveLevel: "productionLevel", readPreference: "primaryPreferred", maxTimeMs: 15000, spec: remote, legacyUri: false, needsReview: false,
    hasPassword: true, hasKeyPassword: false, hasSshSecret: false, hasProxyPassword: false, favorite: false, domain: "generic", aiPrefs: { denyFields: [], glossary: [] }, tlsRelax: "none", uriMasked: "", ...o,
  }) as ProfileView;

describe("normalizeSpec / cleanSpec", () => {
  it("fills every nested object so the form can bind without guards", () => {
    const s = normalizeSpec(null);
    expect(s.auth.mechanism).toBe("default");
    expect(s.hosts).toEqual([{ host: "", port: 27017 }]);
    expect(s.tunnel).toEqual({ kind: "none" });
  });

  it("sends null for empty strings, drops empty extras and forces $external for X.509 and PLAIN", () => {
    const s = state({ ...remote, auth: { mechanism: "x509", username: " CN=me ", source: "admin" }, database: " ", extra: [{ key: "maxPoolSize", value: "" }, { key: "minPoolSize", value: "1" }] });
    const c = cleanSpec(s);
    expect(c.database).toBeNull();
    expect(c.auth?.source).toBe("$external");
    expect(c.auth?.username).toBe("CN=me");
    expect(c.extra).toEqual([{ key: "minPoolSize", value: "1" }]);
  });

  it("SRV keeps one host and no port; going back to Standard restores the default port", () => {
    const srv = withScheme(normalizeSpec({ ...remote, hosts: [{ host: "a.example.com", port: 1 }, { host: "b.example.com", port: 2 }] }), "srv");
    expect(srv.hosts).toEqual([{ host: "a.example.com", port: null }]);
    expect(withScheme(srv, "standard").hosts).toEqual([{ host: "a.example.com", port: 27017 }]);
    expect(cleanSpec({ spec: { ...srv, hosts: [{ host: "a.example.com", port: 5 }] }, allowed: [] }).hosts).toEqual([{ host: "a.example.com", port: null }]);
  });

  it("parses the allowed rows and drops the bad ones; link-local never passes", () => {
    expect(parseAllowed("rs1.internal:27017")).toEqual({ host: "rs1.internal", port: 27017 });
    expect(parseAllowed("rs1.internal")).toBeUndefined();
    expect(parseAllowed("rs1.internal:99999")).toBeUndefined();
    const s = state({ ...remote, tunnel: { kind: "ssh", host: "bastion.example.com", user: "me", auth: "agent", useSshConfig: true, allowedHosts: [] } }, { allowed: ["rs1.internal:27017", "nonsense"] });
    expect(cleanSpec(s).tunnel).toMatchObject({ kind: "ssh", allowedHosts: [{ host: "rs1.internal", port: 27017 }] });
    expect(problemsOf(s).map((p) => p.code)).toContain("allowed.format");
    const ll = state({ ...remote, tunnel: { kind: "ssh", host: "b.example.com", user: "me", auth: "agent", useSshConfig: true, allowedHosts: [] } }, { allowed: ["169.254.169.254:80"] });
    expect(problemsOf(ll).map((p) => p.code)).toContain("allowed.invalid");
  });
});

describe("problems", () => {
  it("needs a name and a host, and links each problem to its tab", () => {
    const ps = problemsOf(state(normalizeSpec(null), { name: "" }));
    expect(ps.map((p) => `${p.tab}:${p.code}`)).toEqual(expect.arrayContaining(["header:name.required", "connection:host.required"]));
    expect(tabOfPath("tls.caFile")).toBe("tls");
    expect(tabOfPath("tunnel.allowedHosts.0")).toBe("tunnel");
    expect(tabOfPath("extra.0.key")).toBe("advanced");
  });

  it("refuses PLAIN or a saved password over TLS Off to a remote host inline", () => {
    const plain = state({ ...remote, auth: { mechanism: "plain", username: "u" }, tls: { mode: "off" } });
    expect(blocking(problemsOf(plain)).map((p) => p.code)).toContain("config.plainRemote");
    const saved = state({ ...remote, tls: { mode: "off" } });
    expect(blocking(problemsOf(saved)).map((p) => p.code)).toContain("config.plainRemote");
    const ok = state({ ...remote, auth: { ...remote.auth, savePassword: false }, tls: { mode: "off" } });
    expect(blocking(problemsOf(ok)).map((p) => p.code)).not.toContain("config.plainRemote");
  });

  it("clamps extra options and the query time limit", () => {
    const s = state({ ...remote, extra: [{ key: "maxPoolSize", value: "99" }, { key: "readConcernLevel", value: "bogus" }] }, { maxTimeS: "0" });
    const codes = problemsOf(s).map((p) => p.code);
    expect(codes).toEqual(expect.arrayContaining(["extra.range", "extra.value", "maxTime.range"]));
  });

  it("X.509 without a client certificate is a problem on the TLS tab", () => {
    const ps = problemsOf(state({ ...remote, auth: { mechanism: "x509" } }));
    expect(ps.find((p) => p.code === "x509.needsCert")?.tab).toBe("tls");
  });
});

describe("level, override and typed confirmations", () => {
  it("a new profile's tag follows the host rule until the user touches it", () => {
    expect(initialState({ defaultAi: "off", initial: { spec: local } }).environment).toBe("local");
    expect(initialState({ defaultAi: "off", initial: { spec: remote } }).environment).toBe("production");
    expect(initialState({ defaultAi: "off", initial: { spec: remote, environment: "sandbox" } }).environment).toBe("sandbox");
  });

  it("raising safety needs nothing; AI on, the typed host, certificate relaxing and a removed deny field need the name", () => {
    expect(loweringReasons(state(), view())).toEqual([]);
    expect(loweringReasons(state(remote, { aiMode: "schemaOnly" }), view())).toEqual(["ai"]);
    expect(loweringReasons(state(remote, { aiMode: "schemaOnly", environment: "production" }), view({ aiMode: "schemaOnly" }))).toEqual([]);
    expect(loweringReasons(state(remote, { environment: "sandbox" }), view())).toEqual(["tag"]);
    expect(loweringReasons(state(remote, { denyFields: [] }), view({ aiPrefs: { denyFields: ["email"], glossary: [] } }))).toEqual(["deny"]);
    expect(loweringReasons(state(local, { tlsRelax: "certificates", environment: "local" }), view({ spec: local, environment: "local" }))).toEqual(["relax"]);
    const typed = state(remote, { typedHost: "DB.example.com" });
    expect(loweringReasons(typed, view())).toEqual(["override"]);
    expect(loweringReasons(state(remote, { typedHost: "wrong.example.com" }), view())).toEqual([]);
  });

  it("confirmed() compares the typed text with the name", () => {
    const s = state(remote, { aiMode: "schemaOnly", confirm: "Acme" });
    expect(confirmed(s, view())).toBe(true);
    expect(confirmed({ ...s, confirm: "acme" }, view())).toBe(false);
    expect(confirmed(state(), view())).toBe(true);
  });

  it("the override is bound to the tunnel host when there is a tunnel, and it makes the level local only with the typed host", () => {
    const tun = state({ ...remote, hosts: [{ host: "127.0.0.1", port: 27017 }], tunnel: { kind: "ssh", host: "bastion.example.com", user: "me", auth: "agent", useSshConfig: true, allowedHosts: [] } }, { environment: "sandbox" });
    expect(overrideHostOf(tun)).toBe("bastion.example.com");
    expect(effectiveLevelOf(tun)).toBe("productionLevel");
    expect(effectiveLevelOf({ ...tun, typedHost: "bastion.example.com" })).toBe("local");
    expect(effectiveLevelOf({ ...tun, environment: "production", typedHost: "bastion.example.com" })).toBe("productionLevel");
  });

  it("a saved override is kept without retyping, and removing it sends an empty string", () => {
    const saved = view({ levelOverride: true, environment: "sandbox" });
    const s = state(remote, { environment: "sandbox" });
    expect(overrideState(s, saved)).toEqual({ active: true, typedNow: false, clearing: false });
    expect(toInput({ state: s, old: saved, secrets: NO_SECRETS }).levelOverrideHost).toBeUndefined();
    expect(toInput({ state: { ...s, overrideCleared: true }, old: saved, secrets: NO_SECRETS }).levelOverrideHost).toBe("");
  });

  it("certificate relaxing is offered only below the Production level", () => {
    expect(relaxAllowed(state(local, { environment: "local" }))).toBe(true);
    expect(relaxAllowed(state(remote, { environment: "sandbox" }))).toBe(false);
    expect(relaxAllowed(state(local, { environment: "production" }))).toBe(false);
  });
});

describe("toInput", () => {
  it("maps the form to a ProfileInput: read-only always, spec instead of uri, secrets only when typed and in use", () => {
    const s = state(remote, { group: " Prod ", favorite: true, aiMode: "off" });
    const i = toInput({ state: s, secrets: { ...NO_SECRETS, password: "pw-1", sshSecret: "unused" }, draft: "d1" });
    expect(i).toMatchObject({ name: "Acme", environment: "production", readOnly: true, group: "Prod", favorite: true, password: "pw-1", draft: "d1", tlsRelax: "none" });
    expect(i.uri).toBeUndefined();
    expect(i.sshSecret).toBeUndefined();
    expect(i.spec?.hosts).toEqual([{ host: "db.example.com", port: 27017 }]);
    expect(i.maxTimeMs).toBe(15000);
  });

  it("does not send a password for no-auth or X.509 and clears one the spec no longer uses", () => {
    const none = toInput({ state: state({ ...remote, auth: { mechanism: "none" } }), old: view(), secrets: { ...NO_SECRETS, password: "x" } });
    expect(none.password).toBe("");
    const keep = toInput({ state: state(), old: view(), secrets: NO_SECRETS });
    expect(keep.password).toBeUndefined();
    const forget = toInput({ state: state(), old: view(), secrets: NO_SECRETS, cleared: ["password"] });
    expect(forget.password).toBe("");
  });

  it("a legacy profile that was not converted sends nothing about the connection", () => {
    const i = toInput({ state: state(), old: view({ legacyUri: true, spec: null }), secrets: { ...NO_SECRETS, password: "x" }, legacyKept: true });
    expect(i.spec).toBeUndefined();
    expect(i.password).toBeUndefined();
    expect(i.uri).toBeUndefined();
  });

  it("carries the typed confirmation only when something is lowered", () => {
    expect(toInput({ state: state(remote, { confirm: "Acme" }), old: view(), secrets: NO_SECRETS }).confirm).toBeUndefined();
    expect(toInput({ state: state(remote, { confirm: "Acme", aiMode: "schemaOnly" }), old: view(), secrets: NO_SECRETS }).confirm).toBe("Acme");
  });

  it("never serialises a secret into anything but its own field", () => {
    const i = toInput({ state: state(), secrets: { ...NO_SECRETS, password: "CANARY-pw" } });
    const { password, ...rest } = i;
    expect(password).toBe("CANARY-pw");
    expect(JSON.stringify(rest)).not.toContain("CANARY");
  });
});

describe("secrets and identity", () => {
  it("slots in use follow the mechanism, the client certificate and the tunnel", () => {
    expect(slotsInUse(normalizeSpec(local))).toEqual([]);
    expect(slotsInUse(normalizeSpec(remote))).toEqual(["password"]);
    expect(slotsInUse(normalizeSpec({ ...remote, tls: { mode: "on", clientCertFile: "/c/pem" }, tunnel: { kind: "ssh", host: "b", user: "u", auth: "password" } }))).toEqual(["password", "keyPassword", "sshSecret"]);
    expect(slotsInUse(normalizeSpec({ ...remote, auth: { mechanism: "x509" }, tunnel: { kind: "socks5", host: "p", port: 1080, username: "u" } }))).toEqual(["proxyPassword"]);
  });

  it("warns that a saved secret is dropped when the destination changes", () => {
    const old = view();
    const same = connIdentity(remote);
    const moved = connIdentity({ ...remote, hosts: [{ host: "other.example.com", port: 27017 }] });
    expect(secretsWillBeDropped(same, same, old)).toBe(false);
    expect(secretsWillBeDropped(moved, same, old)).toBe(true);
    expect(secretsWillBeDropped(moved, same, view({ hasPassword: false }))).toBe(false);
  });
});

describe("URI paste", () => {
  const parsed = (o: Partial<UriParse> = {}): UriParse => ({ spec: { ...remote, scheme: "srv", hosts: [{ host: "c0.mongodb.net" }] }, hasPassword: false, hasKeyPassword: false, warnings: [], unsupported: [], ...o });

  it("fills the spec, keeps name/AI, and follows the host rule for the tag until touched", () => {
    const s = state(local, { name: "Mine", aiMode: "schemaOnly", environment: "local", envTouched: false });
    const n = applyParsed(s, parsed());
    expect(n.spec.scheme).toBe("srv");
    expect(n.name).toBe("Mine");
    expect(n.aiMode).toBe("schemaOnly");
    expect(n.environment).toBe("production");
    expect(applyParsed({ ...s, envTouched: true }, parsed()).environment).toBe("local");
  });

  it("an Atlas placeholder asks for the password; read-only options are collapsed as info", () => {
    expect(wantsPassword(parsed({ warnings: [{ code: "placeholderPassword" }] }))).toBe(true);
    expect(wantsPassword(parsed())).toBe(false);
    const g = groupNotes(parsed({ warnings: [{ code: "ignoredReadOnly", option: "retryWrites" }, { code: "duplicate", option: "x" }], unsupported: [{ code: "proxy" }] }));
    expect(g.info).toHaveLength(1);
    expect(g.warnings.map((n) => n.code)).toEqual(["duplicate"]);
    expect(g.unsupported).toHaveLength(1);
  });
});
