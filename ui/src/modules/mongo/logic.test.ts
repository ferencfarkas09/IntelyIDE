import { describe, expect, it } from "vitest";
import type { ConnectionView, ProfileView } from "../../ipc/mongo";
import { AI_EXAMPLES, dateBounds, effectiveTotal, formatBytes, isDangerous, levelNote, parseIntField, rangeLabel, readOnlyUserCommand, readUri, roleView, testSummary, windowFor } from "./logic";

const profile = (p: Partial<ProfileView>): Pick<ProfileView, "environment" | "effectiveLevel" | "levelOverride"> => ({ environment: "local", effectiveLevel: "local", levelOverride: false, ...p });

describe("effective level", () => {
  it("treats a production tag or any non-loopback host as dangerous", () => {
    expect(isDangerous(profile({}))).toBe(false);
    expect(isDangerous(profile({ environment: "production" }))).toBe(true);
    expect(isDangerous(profile({ effectiveLevel: "productionLevel" }))).toBe(true);
    expect(levelNote(profile({ effectiveLevel: "productionLevel" }))).toMatch(/Non-loopback/);
    expect(levelNote(profile({ levelOverride: true }))).toMatch(/lowered|local/i);
  });

  it("reads a typed connection string without leaking credentials", () => {
    const r = readUri("mongodb://admin:s3cret@127.0.0.1:27017/intely_test_shop");
    expect(r).toMatchObject({ ok: true, host: "127.0.0.1:27017", level: "local", hasCredentials: true, srv: false });
    expect(JSON.stringify(r)).not.toContain("s3cret");
    expect(readUri("mongodb+srv://u:p@cluster0.example.net/db")).toMatchObject({ host: "cluster0.example.net (srv)", level: "productionLevel", srv: true, tls: true });
    expect(readUri("mongodb://db1.happy.internal:27017")).toMatchObject({ level: "productionLevel" });
    expect(readUri("mongodb://localhost")).toMatchObject({ level: "local", hasCredentials: false });
    expect(readUri("http://x")).toMatchObject({ ok: false, error: "scheme" });
    expect(readUri("mongodb://")).toMatchObject({ ok: false });
  });
});

describe("role chip", () => {
  it("always says read-only here is an app-level guard when the user can write or is unknown", () => {
    expect(roleView({ role: "readOnly" })).toMatchObject({ tone: "ok", label: "Read-only user" });
    expect(roleView({ role: "canWrite", actions: ["insert", "update"], noAuth: false })).toMatchObject({ tone: "warn" });
    expect(roleView({ role: "canWrite", actions: ["insert"], noAuth: false }).detail).toMatch(/app-level guard/);
    expect(roleView({ role: "unknown", reason: "no privileges" }).detail).toMatch(/app-level guard/);
    expect(roleView({ role: "canWrite", actions: [], noAuth: true }).label).toBe("No access control");
    expect(roleView(undefined).tone).toBe("neutral");
  });

  it("summarises a test in one line", () => {
    const c = { pingMs: 142, serverVersion: "6.0.28", topology: "replicaSet", role: { role: "readOnly" } } as ConnectionView;
    expect(testSummary(c)).toBe("Connected in 142 ms, MongoDB 6.0.28, replica set, read access");
  });

  it("gives a createUser command with no password in it", () => {
    const cmd = readOnlyUserCommand("shop");
    expect(cmd).toContain('role: "read"');
    expect(cmd).toContain("passwordPrompt()");
  });
});

describe("paging arithmetic", () => {
  it("adds the user's skip to the window and stops at the user's limit", () => {
    expect(windowFor(0, 50, 0, 0)).toEqual({ skip: 0, limit: 50 });
    expect(windowFor(2, 50, 10, 0)).toEqual({ skip: 110, limit: 50 });
    expect(windowFor(1, 50, 0, 70)).toEqual({ skip: 50, limit: 20 });
    expect(windowFor(2, 50, 0, 70)).toBeNull();
  });

  it("caps the footer total by skip and limit", () => {
    expect(effectiveTotal(100_000, 0, 0)).toBe(100_000);
    expect(effectiveTotal(100, 30, 0)).toBe(70);
    expect(effectiveTotal(100, 30, 20)).toBe(20);
    expect(effectiveTotal(10, 30, 0)).toBe(0);
  });

  it("labels the footer range from the shown window and the applied total", () => {
    expect(rangeLabel(0, 50, 50, { value: 100_000, exact: false }, true)).toBe("1–50 of ~100,000");
    expect(rangeLabel(1, 50, 10, { value: 60, exact: true }, false)).toBe("51–60 of 60");
    expect(rangeLabel(0, 50, 50, undefined, true)).toBe("1–50+");
    expect(rangeLabel(0, 50, 0, undefined, false)).toBe("0");
  });

  it("reads number fields leniently", () => {
    expect([parseIntField(""), parseIntField(" 12 "), parseIntField("-3"), parseIntField("x")]).toEqual([0, 12, 0, 0]);
    expect(formatBytes(2048)).toBe("2.0 KB");
  });
});

describe("review chips and examples", () => {
  it("shows the date boundaries of a generated filter in Budapest time", () => {
    const f = '{"status":"open","createdAt":{"$gte":{"$date":"2026-09-29T22:00:00Z"},"$lt":{"$date":"2026-10-03T22:00:00Z"}}}';
    // $gte and $lt sit inside one object here, so only the first operator of a field is matched; both forms must not throw
    expect(dateBounds(f)[0]).toBe("createdAt from 2026-09-30 00:00 Budapest");
    expect(dateBounds('{ createdAt: { $gte: ISODate("2026-01-15T11:00:00Z") } }')).toEqual(["createdAt from 2026-01-15 12:00 Budapest"]);
    expect(dateBounds('{"status":"open"}')).toEqual([]);
    expect(dateBounds('{"a":{"$gt":{"$date":"not a date"}}}')).toEqual([]);
  });

  it("only suggests questions a find can answer", () => {
    for (const q of AI_EXAMPLES) expect(q).not.toMatch(/legtöbb|duplik|duplicate|group|csoportos/i);
  });

  it("does not trust *.localhost as a loopback host", () => {
    expect(readUri("mongodb://app.localhost:27017/x").level).toBe("productionLevel");
    expect(readUri("mongodb://localhost:27017/x").level).toBe("local");
  });
});

import type { ConnSpec } from "../../ipc/mongo";
import { callerZone, connIdentity, ENV_LABEL, ERROR_TITLES, levelOfSpec, startingSpec, validateSpec } from "./logic";
import { setLocale } from "../../i18n";
import { relativeTime } from "./ejson";

const base = (o: Partial<ConnSpec> = {}): ConnSpec => ({ scheme: "standard", hosts: [{ host: "db.example.com", port: 27017 }], auth: { mechanism: "default", username: "u", savePassword: false }, tls: { mode: "auto" }, tunnel: { kind: "none" }, ...o });
const codes = (s: ConnSpec) => validateSpec(s).map((p) => p.code);

describe("connection identity", () => {
  it("changes with host, port, user, mechanism, TLS mode and tunnel, and with nothing else", () => {
    const id = connIdentity(base());
    expect(connIdentity(base())).toBe(id);
    for (const other of [
      base({ hosts: [{ host: "other.example.com", port: 27017 }] }),
      base({ hosts: [{ host: "db.example.com", port: 27018 }] }),
      base({ auth: { mechanism: "default", username: "v" } }),
      base({ auth: { mechanism: "scramSha1", username: "u" } }),
      base({ tls: { mode: "on" } }),
      base({ scheme: "srv" }),
      base({ tunnel: { kind: "socks5", host: "127.0.0.1", port: 1080 } }),
      base({ tunnel: { kind: "ssh", host: "b.example.com", user: "me" } }),
    ]) expect(connIdentity(other)).not.toBe(id);
    expect(connIdentity(base({ database: "x", appName: "y", auth: { mechanism: "default", username: "u", savePassword: true } }))).toBe(id);
    expect(connIdentity(base({ hosts: [{ host: "DB.example.com", port: 27017 }] }))).toBe(id);
  });
});

describe("spec validation (UI mirror)", () => {
  it("accepts a normal spec and the wizard's starting points once the host is filled in", () => {
    expect(validateSpec(base())).toEqual([]);
    for (const k of ["atlas", "local", "network", "ssh", "string"] as const) {
      const { spec } = startingSpec(k);
      const filled: ConnSpec = { ...spec, hosts: spec.hosts!.map((h) => ({ ...h, host: h.host || "db.example.com" })), tunnel: spec.tunnel?.kind === "ssh" ? { ...spec.tunnel, host: "bastion.example.com", user: "me" } : spec.tunnel };
      expect(validateSpec(filled), k).toEqual([]);
    }
    expect(startingSpec("local").environment).toBe("local");
    expect(startingSpec("atlas").environment).toBe("production");
  });

  it("reports the rules of the spec by code", () => {
    expect(codes(base({ hosts: [] }))).toContain("hosts.required");
    expect(codes(base({ hosts: [{ host: "-x" }] }))).toContain("host.invalid");
    expect(codes(base({ hosts: [{ host: "a b" }] }))).toContain("host.invalid");
    expect(codes(base({ hosts: [{ host: "a", port: 70000 }] }))).toContain("port.range");
    expect(codes(base({ scheme: "srv", hosts: [{ host: "a.net", port: 27017 }] }))).toContain("srv.noPort");
    expect(codes(base({ scheme: "srv", hosts: [{ host: "a.net" }, { host: "b.net" }] }))).toContain("srv.oneHost");
    expect(codes(base({ database: "a.b" }))).toContain("database.invalid");
    expect(codes(base({ topology: { maxStalenessS: 30 } }))).toContain("staleness.min");
    expect(codes(base({ auth: { mechanism: "x509" } }))).toContain("x509.needsCert");
    expect(codes(base({ tls: { caFile: "ca.pem" } }))).toContain("path.notAbsolute");
    expect(codes(base({ tls: { caFile: "/a/../b.pem" } }))).toContain("path.invalid");
    expect(codes(base({ extra: [{ key: "w", value: "1" }] }))).toContain("extra.notAllowed");
    expect(codes(base({ compressors: ["zlib", "zlib"] }))).toContain("compressor.duplicate");
    expect(codes(base({ tunnel: { kind: "ssh", host: "-o", user: "me" } }))).toContain("ssh.host");
    expect(codes(base({ tunnel: { kind: "ssh", host: "b.example.com", user: "-me" } }))).toContain("ssh.user");
    expect(codes(base({ tunnel: { kind: "ssh", host: "b.example.com", user: "me", auth: "agent", keyFile: "/k" } }))).toContain("ssh.keyFileAuth");
    expect(codes(base({ tunnel: { kind: "ssh", host: "b.example.com", user: "me", allowedHosts: [{ host: "169.254.169.254", port: 80 }] } }))).toContain("allowed.invalid");
    expect(codes(base({ tls: { mode: "off" }, auth: { mechanism: "plain", username: "u" } }))).toContain("config.plainRemote");
    expect(codes(base({ tls: { mode: "off" }, auth: { mechanism: "default", username: "u", savePassword: true } }))).toContain("config.plainRemote");
    expect(codes(base({ tls: { mode: "off" }, auth: { mechanism: "default", username: "u", savePassword: false } }))).toEqual([]);
    expect(codes(base({ hosts: [{ host: "127.0.0.1" }], tls: { mode: "off" }, auth: { mechanism: "plain", username: "u" } }))).toEqual([]);
    const warn = validateSpec(base({ topology: { readPreference: "secondary" } }));
    expect(warn).toEqual([{ path: "topology.readPreference", code: "select.noReplicaSet", warning: true }]);
  });

  it("applies the host rule: any tunnel, srv or non-loopback host is production-level", () => {
    expect(levelOfSpec(base({ hosts: [{ host: "localhost" }] })).level).toBe("local");
    expect(levelOfSpec(base({ hosts: [{ host: "localhost" }], tunnel: { kind: "socks5", host: "127.0.0.1", port: 1 } }))).toMatchObject({ level: "productionLevel", reason: "tunnel" });
    expect(levelOfSpec(base({ scheme: "srv", hosts: [{ host: "c.example.net" }] })).reason).toBe("srv");
    expect(levelOfSpec(base())).toMatchObject({ level: "productionLevel", reason: "remoteHost", host: "db.example.com" });
  });
});

describe("misc helpers", () => {
  it("names the caller's zone, words date chips in a given zone and parameterises the createUser snippet", () => {
    expect(callerZone()).toMatchObject({ utcOffsetMin: expect.any(Number), tzName: expect.any(String) });
    const f = '{ createdAt: { $gte: ISODate("2026-01-15T11:00:00Z") } }';
    expect(dateBounds(f, "America/New_York")).toEqual(["createdAt from 2026-01-15 06:00 New York"]);
    expect(dateBounds(f, null)[0]).toMatch(/^createdAt from 2026-01-15 /);
    expect(readOnlyUserCommand("shop", "analyst")).toContain('user: "analyst"');
    expect(readOnlyUserCommand("shop")).toContain('user: "intely_readonly"');
  });

  it("follows the language through getters and ICU plurals", async () => {
    expect(ENV_LABEL.sandbox).toBe("Test");
    await setLocale("hu", { persist: false });
    try {
      expect(ERROR_TITLES.auth).toBe("Sikertelen bejelentkezés");
      expect(ENV_LABEL.production).toBe("Éles");
      expect(roleView({ role: "readOnly" }).label).toBe("Csak olvasó felhasználó");
      // the footer: the language's own separator word and digit grouping (no English "of", no en-US commas)
      expect(rangeLabel(0, 50, 50, { value: 100_000, exact: false }, true)).toBe("1–50 / ~100\u00a0000");
      expect(relativeTime(Date.UTC(2026, 9, 3) - 5 * 86_400_000, Date.UTC(2026, 9, 3))).toBe("5 nappal ezelőtt");
      expect(testSummary({ pingMs: 5, serverVersion: "7", topology: "standalone", role: { role: "readOnly" } } as ConnectionView)).toBe("Csatlakozva 5 ms alatt, MongoDB 7, önálló szerver, olvasási jog");
    } finally {
      await setLocale("en", { persist: false });
    }
    expect(ERROR_TITLES.auth).toBe("Sign-in failed");
  });
});
