import { describe, expect, it } from "vitest";
import { createMockMongoCore } from "./mongoCore";

const fixture = { name: "Fixture", environment: "local" as const, uri: "mongodb://127.0.0.1:27017/intely_test_shop" };

describe("mock mongo core", () => {
  it("is off until the switch is turned on and never returns a connection string", async () => {
    const m = createMockMongoCore();
    expect((await m.status()).enabled).toBe(false);
    const p = await m.profileSave(fixture);
    await expect(m.connect(p.id)).rejects.toMatchObject({ code: "mongoDisabled" });
    await m.setEnabled(true);
    const c = await m.connect(p.id);
    expect(c.role).toMatchObject({ role: "canWrite", noAuth: true });
    expect(c.roleElevated).toBe(true);
    // only the masked rendering ever leaves: no user info, no password
    expect(JSON.stringify([p, c, await m.profiles(), await m.status()])).not.toMatch(/mongodb:\/\/[^"]*@/);
  });

  it("starts read-only, asks the typed name to lower a safety setting and treats a remote host as production-level", async () => {
    const m = createMockMongoCore({ enabled: true });
    const p = await m.profileSave(fixture);
    expect(p).toMatchObject({ readOnly: true, aiMode: "off", effectiveLevel: "local", readPreference: "primaryPreferred" });
    await expect(m.profileSave({ ...fixture, id: p.id, readOnly: false })).rejects.toMatchObject({ code: "mongoConfirm" });
    await expect(m.profileSave({ ...fixture, id: p.id, uri: undefined, readOnly: false, confirm: "Fixture" })).resolves.toMatchObject({ readOnly: false });
    const remote = await m.profileSave({ name: "Remote", environment: "local", uri: "mongodb://u:pw@db.example.com/app" });
    expect(remote).toMatchObject({ effectiveLevel: "productionLevel", readPreference: "secondaryPreferred", host: "db***.example.com" });
  });

  it("pages a find in windows of 50 over a capped result and cannot express a write", async () => {
    const m = createMockMongoCore({ enabled: true });
    const p = await m.profileSave(fixture);
    await m.connect(p.id);
    const base = { db: "intely_test_shop", collection: "orders" };
    const w = await m.run({ tab: "t1", connection: p.id, command: { cmd: "find", ...base, filter: "{status: 'open'}" } });
    expect(w.docs).toHaveLength(50);
    expect(w.loaded).toBeLessThanOrEqual(1000);
    expect(JSON.parse(w.docs[0]).total.$numberDouble).toBeTypeOf("string");
    expect((await m.window("t1", 50, 50)).offset).toBe(50);
    const all = await m.run({ tab: "t2", connection: p.id, command: { cmd: "find", ...base, filter: "" } });
    expect(all).toMatchObject({ loaded: 1000, truncated: true, hasMore: true });
    await expect(m.run({ tab: "t3", connection: p.id, command: { cmd: "insertOne", ...base } as never })).rejects.toMatchObject({ code: "mongoInvalid" });
    await m.setEnabled(false);
    await expect(m.window("t1", 0, 50)).rejects.toMatchObject({ code: "mongoDisabled" });
  });
});

// --- the connection manager ------------------------------------------------------------------------------------------------------

import { MOCK_DIAGNOSES, createMockMongoEngine, parseConnection, renderConnectionMasked } from "./mongoCore";
import type { ConnSpec, ProfileInput, TestEvent } from "../mongoCore";

const CANARY = "p@ss:w/rd%#?[]é 1";
const direct = (host: string, extra: Partial<ConnSpec> = {}): ConnSpec => ({ scheme: "standard", hosts: [{ host, port: 27017 }], auth: { mechanism: "default", username: "reader", source: "admin", savePassword: true }, tls: { mode: "auto" }, tunnel: { kind: "none" }, ...extra });
const input = (spec: ConnSpec, o: Partial<ProfileInput> = {}): ProfileInput => ({ name: "Acme", environment: "production", spec, ...o });
const on = () => createMockMongoEngine({ enabled: true });

describe("connection string parser", () => {
  it("fills a spec, keeps the password out of it and survives hostile characters", () => {
    const uri = `mongodb+srv://reader:${encodeURIComponent(CANARY)}@cluster0.k3x9q.mongodb.net/shop?retryWrites=true&w=majority&appName=App&readPreference=secondaryPreferred&compressors=zlib,bogus`;
    const p = parseConnection(uri);
    expect(p.password).toBe(CANARY);
    expect(p.spec).toMatchObject({ scheme: "srv", hosts: [{ host: "cluster0.k3x9q.mongodb.net" }], database: "shop", auth: { username: "reader" }, appName: "App", compressors: ["zlib"] });
    expect(p.spec.topology?.readPreference).toBe("secondaryPreferred");
    expect(JSON.stringify(p.spec)).not.toContain("ss:w");
    expect(p.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["ignoredReadOnly", "unknownCompressor"]));
    // a raw @ and / inside the password do not break the host
    expect(parseConnection("mongodb://u:a@b/c@db.example.com:27017/x").spec.hosts).toEqual([{ host: "db.example.com", port: 27017 }]);
  });

  it("treats Atlas placeholders as no password yet, lists unsupported options and flags relative paths", () => {
    const p = parseConnection("mongodb+srv://<username>:<db_password>@c.example.net/?authMechanism=MONGODB-AWS&proxyHost=x&tlsCAFile=~/ca.pem&tlsAllowInvalidHostnames=true&bogus=1&replicaSet=a&replicaSet=b");
    expect(p.password).toBeUndefined();
    expect(p.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["placeholderPassword", "placeholderUsername", "relativePath", "unsupportedInBuild", "duplicate"]));
    expect(p.unsupported.map((w) => w.code)).toEqual(expect.arrayContaining(["authMechanism", "proxy", "unknownOption"]));
    expect(() => parseConnection("http://x")).toThrow();
  });

  it("round-trips through the masked rendering, which never holds the password", () => {
    const x = parseConnection(`mongodb://reader:${encodeURIComponent(CANARY)}@a.example.com:27017,b.example.com/db?replicaSet=rs0&tls=true&authSource=admin&maxPoolSize=3`);
    const masked = renderConnectionMasked(x.spec);
    expect(masked).not.toContain("ss:w");
    expect(masked).toContain("reader:***@");
    expect(parseConnection(masked).spec).toEqual(x.spec);
  });
});

describe("draft vault, identity and secrets", () => {
  it("parses a pasted string into the vault and never echoes the password back", async () => {
    const e = on();
    const r = await e.api.uriParse(`mongodb://reader:${encodeURIComponent(CANARY)}@db.example.com/shop`);
    expect(r).toMatchObject({ hasPassword: true, hasKeyPassword: false });
    expect(r.draft).toBeTruthy();
    expect(JSON.stringify(r)).not.toContain("ss:w");
    const saved = await e.api.profileSave(input(r.spec, { draft: r.draft }));
    expect(saved).toMatchObject({ hasPassword: true, legacyUri: false });
    expect(JSON.stringify([saved, await e.api.profiles(), await e.api.status(), await e.api.secretsStatus(saved.id)])).not.toContain("ss:w");
    expect(e.vaultSize()).toBe(0);
    await expect(e.api.connect(saved.id)).resolves.toMatchObject({ id: saved.id });
  });

  it("expires drafts after 10 minutes, caps the vault at 16 and drops everything when the switch goes off", async () => {
    let t = 1_000;
    const e = createMockMongoEngine({ enabled: true, now: () => t });
    const uri = "mongodb://u:pw@db.example.com/x";
    const first = await e.api.uriParse(uri);
    t += 10 * 60_000 + 1;
    const spec = first.spec;
    const saved = await e.api.profileSave(input(spec, { draft: first.draft }));
    expect(saved.hasPassword).toBe(false);
    for (let i = 0; i < 20; i++) await e.api.uriParse(uri);
    expect(e.vaultSize()).toBe(16);
    await e.api.setEnabled(false);
    expect(e.vaultSize()).toBe(0);
  });

  it("refuses a secret typed for another destination (changed host, user, mechanism, TLS mode, tunnel)", async () => {
    const e = on();
    const saved = await e.api.profileSave(input(direct("a.example.com"), { password: "secret-one", confirm: "Acme" }));
    expect(saved.hasPassword).toBe(true);
    const variants: ConnSpec[] = [
      direct("b.example.com"),
      direct("a.example.com", { auth: { mechanism: "default", username: "other", source: "admin", savePassword: true } }),
      direct("a.example.com", { auth: { mechanism: "scramSha256", username: "reader", source: "admin", savePassword: true } }),
      direct("a.example.com", { tls: { mode: "on" } }),
      direct("a.example.com", { tunnel: { kind: "socks5", host: "127.0.0.1", port: 1080 } }),
    ];
    for (const v of variants) {
      // a test of the edited, unsaved form must not reuse the stored password
      await expect(e.api.test(input(v, { id: saved.id }))).rejects.toMatchObject({ code: "mongoNeedSecret" });
      // saving it clears the stored secret
      const again = await e.api.profileSave(input(v, { id: saved.id, environment: "production", confirm: "Acme" }));
      expect(again.hasPassword).toBe(false);
      await e.api.profileSave(input(direct("a.example.com"), { id: saved.id, password: "secret-one", confirm: "Acme" }));
    }
    // a draft typed for another host is not redeemed
    const draft = await e.api.uriParse("mongodb://reader:pw@evil.example.com/x");
    await expect(e.api.test(input(direct("a.example.com"), { draft: draft.draft }))).rejects.toMatchObject({ code: "mongoNeedSecret" });
  });

  it("asks at connect time for a password that is not saved, and takes it from the session secrets", async () => {
    const e = on();
    const spec = direct("a.example.com", { auth: { mechanism: "default", username: "reader", source: "admin", savePassword: false } });
    const p = await e.api.profileSave(input(spec, { password: "typed-once" }));
    expect(p.hasPassword).toBe(false);
    await expect(e.api.connect(p.id)).rejects.toMatchObject({ code: "mongoNeedSecret", message: "needs:password" });
    await expect(e.api.connect(p.id, { password: "typed-once" })).resolves.toMatchObject({ id: p.id });
    expect(JSON.stringify(await e.api.secretsStatus(p.id))).not.toContain("typed-once");
  });

  it("reports where secrets live and refuses to store any when the store is unavailable", async () => {
    const e = createMockMongoEngine({ enabled: true, secretStore: "unavailable" });
    expect(await e.api.secretsStatus()).toMatchObject({ store: "unavailable", hasPassword: false });
    const p = await e.api.profileSave(input(direct("a.example.com"), { password: "x" }));
    expect(p.hasPassword).toBe(false);
  });

  it("a tampered profile needs review, connect and test refuse, and the re-save clears every secret", async () => {
    const e = on();
    const p = await e.api.profileSave(input(direct("a.example.com"), { password: "keep-me" }));
    e.tamper(p.id);
    expect((await e.api.profiles())[0]).toMatchObject({ needsReview: true, readOnly: true, aiMode: "off", environment: "production" });
    expect((await e.api.status()).notices).toHaveLength(1);
    await expect(e.api.connect(p.id)).rejects.toMatchObject({ code: "mongoNeedsReview" });
    await expect(e.api.test(input(direct("a.example.com"), { id: p.id }))).rejects.toMatchObject({ code: "mongoNeedsReview" });
    const fixed = await e.api.profileSave(input(direct("a.example.com"), { id: p.id }));
    expect(fixed).toMatchObject({ needsReview: false, hasPassword: false });
  });
});

describe("profiles: levels, tags, meta", () => {
  it("makes every tunnel Production-level, whatever the host names say", async () => {
    const e = on();
    const p = await e.api.profileSave(input(direct("127.0.0.1", { auth: { mechanism: "none" }, tunnel: { kind: "ssh", host: "bastion.example.com", user: "me", auth: "agent", allowedHosts: [] } }), { environment: "local" }));
    expect(p).toMatchObject({ hostLevel: "productionLevel", effectiveLevel: "productionLevel" });
    const local = await e.api.profileSave(input(direct("127.0.0.1", { auth: { mechanism: "none" } }), { environment: "local", name: "Loop" }));
    expect(local.effectiveLevel).toBe("local");
  });

  it("refuses relaxed certificate checks at the effective Production level and asks the typed name elsewhere", async () => {
    const e = on();
    await expect(e.api.profileSave(input(direct("db.example.com"), { tlsRelax: "certificates", confirm: "Acme" }))).rejects.toMatchObject({ code: "mongoInvalid" });
    const loop = direct("127.0.0.1", { auth: { mechanism: "none" } });
    await expect(e.api.profileSave(input(loop, { environment: "local", tlsRelax: "certificates" }))).rejects.toMatchObject({ code: "mongoConfirm" });
    await expect(e.api.test(input(loop, { environment: "local", tlsRelax: "certificates" }))).rejects.toMatchObject({ code: "mongoConfirm" });
    await expect(e.api.profileSave(input(loop, { environment: "local", tlsRelax: "certificates", confirm: "Acme" }))).resolves.toMatchObject({ tlsRelax: "certificates" });
  });

  it("changes group, favourite and colour without a typed confirmation", async () => {
    const e = on();
    const p = await e.api.profileSave(input(direct("a.example.com")));
    expect(await e.api.profileMeta(p.id, { group: "Acme", favorite: true, color: "#123456" })).toMatchObject({ group: "Acme", favorite: true, color: "#123456" });
    expect(await e.api.profileMeta(p.id, { group: "" })).toMatchObject({ group: null });
  });

  it("validates the spec and rejects a spec together with a string", async () => {
    const e = on();
    await expect(e.api.profileSave(input(direct("-bad host")))).rejects.toMatchObject({ code: "mongoInvalid" });
    await expect(e.api.profileSave({ ...input(direct("a.example.com")), uri: "mongodb://a" })).rejects.toMatchObject({ code: "mongoInvalid" });
  });

  it("new profiles are Generic unless the Happy preset is on, and a legacy string converts to fields for review", async () => {
    const e = createMockMongoEngine({ enabled: true });
    expect((await e.api.profileSave(input(direct("a.example.com")))).domain).toBe("generic");
    expect((await createMockMongoEngine({ enabled: true, happyPreset: true }).api.profileSave(input(direct("a.example.com")))).domain).toBe("happy");
    const legacy = e.seedLegacy("Old", "mongodb://reader:oldpw@db.example.com/x?retryWrites=true&proxyHost=p");
    expect(legacy).toMatchObject({ legacyUri: true, spec: null, uriMasked: "" });
    const d = await e.api.profileConvert(legacy.id);
    expect(d.input.spec?.hosts?.[0].host).toBe("db.example.com");
    expect(d.dropped.map((n) => n.code)).toEqual(["proxy"]);
    expect(JSON.stringify(d)).not.toContain("oldpw");
    expect((await e.api.profiles())[1]).toMatchObject({ legacyUri: true });
    const saved = await e.api.profileSave({ ...d.input, draft: d.draft });
    expect(saved).toMatchObject({ legacyUri: false, hasPassword: true });
  });
});

describe("test stepper", () => {
  const run = async (e = on(), spec: ConnSpec = direct("db.example.com"), o: Partial<ProfileInput> = {}) => {
    const events: TestEvent[] = [];
    const off = e.api.onTest((x) => events.push(x));
    const report = await e.api.test(input(spec, { password: "pw", ...o }), "t1");
    off();
    return { report, events };
  };

  it("streams running then final states in order and succeeds with members and warnings", async () => {
    const { report, events } = await run(on(), direct("db.example.com", { topology: { replicaSet: "rs0" }, tls: { mode: "off" }, auth: { mechanism: "default", username: "reader", source: "admin", savePassword: false } }));
    expect(report.ok).toBe(true);
    expect(report.steps?.map((s) => s.id)).toEqual(["config", "dns", "connect", "tls", "auth", "permissions"]);
    expect(report.steps?.find((s) => s.id === "tls")?.state).toBe("skipped");
    expect(report.members?.length).toBe(3);
    expect(report.warnings).toContain("plainTextRemote");
    expect(events.filter((x) => x.step!.id === "config").map((x) => x.step!.state)).toEqual(["running", "ok"]);
    expect(events.every((x) => x.testId === "t1")).toBe(true);
  });

  it("fails every diagnosis code on the step the catalogue names and never shows a later step green", async () => {
    for (const [code, def] of Object.entries(MOCK_DIAGNOSES)) {
      const tunnel = code.startsWith("tunnel.");
      const host = `inject-${code.replace(/\./g, "-")}.example.com`;
      const spec = tunnel ? direct("db.example.com", { tunnel: { kind: "ssh", host, user: "me", auth: "agent", allowedHosts: [] } }) : direct(host);
      const { report } = await run(on(), spec);
      const steps = report.steps ?? [];
      expect(report.diagnosis?.code, code).toBe(code);
      expect(report.diagnosis?.class, code).toBe(def.class);
      if (def.class === "authz") {
        expect(report.ok, code).toBe(true);
        expect(steps.find((s) => s.id === "permissions")?.state, code).toBe("warn");
        continue;
      }
      expect(report.ok, code).toBe(false);
      expect(report.errorClass, code).toBe(def.class);
      const at = steps.findIndex((s) => s.state === "failed");
      expect(at, code).toBeGreaterThanOrEqual(0);
      expect(steps[at].id, code).toBe(tunnel && def.step === "tunnel" ? "tunnel" : def.step);
      expect(steps.slice(at + 1).every((s) => s.state === "skipped"), code).toBe(true);
      expect(steps.slice(0, at).every((s) => s.state === "ok" || s.state === "skipped"), code).toBe(true);
      expect(JSON.stringify(report), code).not.toContain("pw\"");
    }
  });

  it("keeps the legacy markers (badauth, unreachable) and reports a bad paste as a report, not a rejection", async () => {
    const e = on();
    expect(await e.api.test({ name: "x", environment: "local", uri: "mongodb://127.0.0.1/?badauth" })).toMatchObject({ ok: false, errorClass: "auth", error: "Authentication failed." });
    expect(await e.api.test({ name: "x", environment: "local", uri: "mongodb://127.0.0.1/?unreachable" })).toMatchObject({ ok: false, errorClass: "timeout" });
    expect(await e.api.test({ name: "x", environment: "local", uri: "nope" })).toMatchObject({ ok: false });
  });

  it("walks the SSH host key flow: unknown, trust, known; changed can never be trusted; forgetting needs the typed host", async () => {
    const e = on();
    const ssh = { host: "bastion.example.com", user: "me", auth: "agent" as const, allowedHosts: [{ host: "db.example.com", port: 27017 }] };
    const spec = direct("db.example.com", { tunnel: { kind: "ssh", ...ssh } });
    const first = await e.api.test(input(spec, { password: "pw" }));
    expect(first).toMatchObject({ ok: false, diagnosis: { code: "tunnel.hostKeyUnknown" }, hostKey: { status: "unknown", host: "bastion.example.com", port: 22 } });
    const hk = await e.api.sshHostkey(ssh);
    expect(hk.fingerprint).toMatch(/^SHA256:/);
    await expect(e.api.sshTrust(hk.host, hk.port, "SHA256:wrong")).rejects.toMatchObject({ code: "mongoHostKey" });
    await e.api.sshTrust(hk.host, hk.port, hk.fingerprint);
    expect((await e.api.sshHostkey(ssh)).status).toBe("known");
    expect((await e.api.test(input(spec, { password: "pw" }))).ok).toBe(true);
    await expect(e.api.sshForget(hk.host, hk.port, "nope")).rejects.toMatchObject({ code: "mongoConfirm" });
    expect((await e.api.sshForget(hk.host, hk.port, hk.host)).old).toEqual([hk.fingerprint]);
    expect((await e.api.sshHostkey(ssh)).status).toBe("unknown");
    const changed = { ...ssh, host: "inject-tunnel-hostKeyChanged.example.com" };
    const ck = await e.api.sshHostkey(changed);
    expect(ck.status).toBe("changed");
    await expect(e.api.sshTrust(ck.host, ck.port, ck.fingerprint)).rejects.toMatchObject({ code: "mongoHostKey" });
    await expect(e.api.sshHostkey({ ...ssh, host: "inject-tunnel-hostKeyUnscannable.example.com" })).rejects.toMatchObject({ message: "tunnel.hostKeyUnscannable" });
  });

  it("refuses replica-set members the relay does not allow until the user allows them", async () => {
    const e = on();
    const ssh = { host: "bastion.example.com", user: "me", auth: "agent" as const, allowedHosts: [] as { host: string; port: number }[] };
    await e.api.sshTrust("bastion.example.com", 22, (await e.api.sshHostkey(ssh)).fingerprint);
    const rs = (allowed: typeof ssh.allowedHosts) => direct("db.example.com", { topology: { replicaSet: "rs0" }, tunnel: { kind: "ssh", ...ssh, allowedHosts: allowed } });
    const blocked = await e.api.test(input(rs([]), { password: "pw" }));
    expect(blocked).toMatchObject({ ok: false, diagnosis: { code: "tunnel.notAllowed" } });
    expect(blocked.refused?.length).toBe(2);
    // a forced "not allowed" has no refused member, yet the message still names a host
    const forced = await e.api.test(input(direct("inject-tunnel-notAllowed.example.com"), { password: "pw" }));
    expect(forced.diagnosis?.code).toBe("tunnel.notAllowed");
    expect(forced.diagnosis?.params.find(([k]) => k === "host")?.[1]).toBe("inject-tunnel-notAllowed.example.com:27017");
    const members = (await e.api.test(input(rs([{ host: "db-b.example.com", port: 27017 }, { host: "db-c.example.com", port: 27017 }]), { password: "pw" }))).members ?? [];
    expect(members).toHaveLength(3);
  });

  it("allows one running test per form id, limits the rate across ids and cancels", async () => {
    let t = 10_000;
    const e = createMockMongoEngine({ enabled: true, now: () => t, testIntervalMs: 1000, latencyMs: 5 });
    const a = e.api.test(input(direct("db.example.com"), { password: "pw" }), "same");
    await expect(e.api.test(input(direct("db.example.com"), { password: "pw" }), "same")).rejects.toMatchObject({ code: "mongoBusy" });
    expect(await e.api.testCancel("same")).toBe(true);
    expect((await a).ok).toBe(false);
    await expect(e.api.test(input(direct("db.example.com"), { password: "pw" }), "other")).rejects.toMatchObject({ code: "mongoBusy" });
    t += 1500;
    await expect(e.api.test(input(direct("db.example.com"), { password: "pw" }), "other")).resolves.toMatchObject({ ok: true });
  });

  it("honours the jails: refused and loopback-only", async () => {
    const refused = createMockMongoEngine({ enabled: true, network: "refused" });
    await expect(refused.api.test(input(direct("127.0.0.1")))).rejects.toMatchObject({ code: "readOnly" });
    await expect(refused.api.detectLocal()).rejects.toMatchObject({ code: "readOnly" });
    const loop = createMockMongoEngine({ enabled: true, network: "loopbackOnly" });
    await expect(loop.api.test(input(direct("db.example.com"), { password: "pw" }))).rejects.toMatchObject({ code: "testJail" });
    expect((await loop.api.test(input(direct("127.0.0.1", { auth: { mechanism: "none" } }), { environment: "local" }))).ok).toBe(true);
  });
});

describe("dialog handles, export and import", () => {
  const exportAll = async (e: ReturnType<typeof on>, ids: string[], o = { includeTunnel: true, includePaths: false }) => {
    const h = (await e.api.dialogSave("export"))!;
    await e.api.profilesExport(ids, o, h.token);
    return { text: e.lastExport()!, handle: h };
  };

  it("exports without secrets, signatures, URIs or (by default) file paths, through a one-time handle", async () => {
    const e = on();
    const p = await e.api.profileSave(input(direct("db.example.com", { tls: { mode: "on", caFile: "/etc/ca.pem" }, tunnel: { kind: "ssh", host: "b.example.com", user: "me", auth: "keyFile", keyFile: "/Users/me/.ssh/id_ed25519", allowedHosts: [] } }), { password: "export-canary", sshSecret: "ssh-canary" }));
    const { text, handle } = await exportAll(e, [p.id]);
    expect(text).not.toMatch(/export-canary|ssh-canary|mongodb:\/\/|"sig"|"rev"|levelOverride|tlsRelax|\/etc\/ca\.pem|id_ed25519/);
    expect(JSON.parse(text)).toMatchObject({ format: "intely-mongo-profiles", version: 1, profiles: [{ name: "Acme", secrets: { password: "needed" } }] });
    expect(handle.fileName).toBe("intely-mongo-profiles.json");
    await expect(e.api.profilesExport([p.id], { includeTunnel: true, includePaths: false }, handle.token)).rejects.toMatchObject({ code: "mongoHandle" });
    const withPaths = await exportAll(e, [p.id], { includeTunnel: true, includePaths: true });
    expect(withPaths.text).toContain("/etc/ca.pem");
    const noTunnel = await exportAll(e, [p.id], { includeTunnel: false, includePaths: false });
    expect(JSON.parse(noTunnel.text).profiles[0].spec.tunnel).toEqual({ kind: "none" });
  });

  it("imports read-only, AI off, no override, Production for a tunnel, with name clashes suffixed and the endpoints previewed", async () => {
    const e = on();
    const doc = {
      format: "intely-mongo-profiles", version: 1,
      profiles: [
        { name: "Tunnelled", environment: "local", spec: direct("127.0.0.1", { tunnel: { kind: "ssh", host: "bastion.example.com", user: "me", auth: "agent", allowedHosts: [] } }), domain: "happy" },
        { name: "Tunnelled", environment: "sandbox", spec: direct("db2.example.com", { tls: { mode: "off" }, auth: { mechanism: "default", username: "reader", savePassword: false } }) },
      ],
    };
    e.queueImportFile(JSON.stringify(doc));
    const h = (await e.api.dialogOpen("import"))!;
    const preview = await e.api.profilesImportPreview(h.token);
    expect(preview.items[0]).toMatchObject({ needsConfirm: true, endpoints: ["127.0.0.1:27017", "bastion.example.com:22"] });
    expect(preview.items[0].warnings).toEqual([{ code: "domainHappyOff" }]);
    expect(preview.items[1].needsConfirm).toBe(true);
    expect(await e.api.profilesImport(h.token, [0, 1])).toMatchObject({ imported: 2 });
    const list = await e.api.profiles();
    expect(list.map((p) => p.name)).toEqual(["Tunnelled", "Tunnelled (2)"]);
    expect(list[0]).toMatchObject({ environment: "production", readOnly: true, aiMode: "off", levelOverride: false, tlsRelax: "none", domain: "generic", hasPassword: false });
    await expect(e.api.profilesImport(h.token, [0])).rejects.toMatchObject({ code: "mongoHandle" });
  });

  it("imports a plain URI list with the passwords going straight to the secret store", async () => {
    const e = on();
    e.queueImportFile(`# my servers\nmongodb://u:uri-canary@db1.example.com/x\n\nmongodb+srv://v:pw2@c.example.net/y`, "servers.txt");
    const h = (await e.api.dialogOpen("import"))!;
    const preview = await e.api.profilesImportPreview(h.token);
    expect(JSON.stringify(preview)).not.toContain("uri-canary");
    await e.api.profilesImport(h.token, [0, 1]);
    const list = await e.api.profiles();
    expect(list).toHaveLength(2);
    expect(list.every((p) => p.hasPassword && p.environment === "production")).toBe(true);
    expect(JSON.stringify(list)).not.toContain("uri-canary");
  });

  it("rejects hostile files with a line number and a code only, never the input text", async () => {
    const e = on();
    for (const [text, expected] of [
      ["mongodb://ok.example.com\nSECRET-CANARY not a uri", /^line 2: notUri$/],
      ['{ "format": "intely-mongo-profiles", "version": 1, "profiles": [ {"name": "x", "spec": {}, "sneaky": "SECRET-CANARY"} ] }', /^profile 1: unknownField$/],
      ['{ "format": "other", "version": 1 }', /^line 1: format$/],
      ["x".repeat(1024 * 1024 + 1), /tooLarge/],
    ] as const) {
      e.queueImportFile(text);
      const h = (await e.api.dialogOpen("import"))!;
      const err = await e.api.profilesImportPreview(h.token).catch((x) => x);
      expect(err.code).toBe("mongoImport");
      expect(err.message).toMatch(expected);
      expect(err.message).not.toContain("SECRET-CANARY");
    }
    const lines = Array.from({ length: 51 }, (_, i) => `mongodb://h${i}.example.com`).join("\n");
    e.queueImportFile(lines);
    await expect(e.api.profilesImportPreview((await e.api.dialogOpen("import"))!.token)).rejects.toMatchObject({ message: "line 51: tooMany" });
  });

  it("expires handles after five minutes, refuses the wrong kind and returns null when the user cancels", async () => {
    let t = 0;
    const e = createMockMongoEngine({ enabled: true, now: () => t });
    expect(await e.api.dialogOpen("import")).toBeNull();
    e.queueImportFile("mongodb://a.example.com");
    const h = (await e.api.dialogOpen("import"))!;
    await expect(e.api.profilesExport([], { includeTunnel: true, includePaths: false }, h.token)).rejects.toMatchObject({ code: "mongoHandle" });
    t += 5 * 60_000 + 1;
    await expect(e.api.profilesImportPreview(h.token)).rejects.toMatchObject({ code: "mongoHandle" });
  });

  it("detects local servers only when asked and reports AI capabilities without a process", async () => {
    const e = createMockMongoEngine({ enabled: true, localHits: [{ host: "127.0.0.1", port: 27017 }], ai: { node: true, claudeCli: false, script: true } });
    expect(await e.api.detectLocal()).toEqual([{ host: "127.0.0.1", port: 27017 }]);
    expect(await e.api.aiCapabilities()).toMatchObject({ claudeCli: false });
  });

  it("resets everything while the switch is off, once the phrase is typed", async () => {
    const e = createMockMongoEngine({ enabled: false });
    await e.api.profileSave(input(direct("a.example.com"), { password: "x" }));
    await expect(e.api.resetAll("", { auditToo: false })).rejects.toMatchObject({ code: "mongoConfirm" });
    expect(await e.api.resetAll("reset", { auditToo: true })).toMatchObject({ profiles: 1, secrets: 1 });
    expect(await e.api.profiles()).toEqual([]);
  });
});
