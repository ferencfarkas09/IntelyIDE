import { describe, expect, it } from "vitest";
import type { ConnSpec, ProfileView } from "../../../ipc/mongo";
import { allGroups, chipsOf, endpointsOf, isAuthFailure, matchesQuery, needsEndpointConfirm, noteKnown, sectionsOf, selectedIndexes, toggled, vanished } from "./logic";

const spec = (over: Partial<ConnSpec> = {}): ConnSpec => ({ scheme: "standard", hosts: [{ host: "127.0.0.1", port: 27017 }], auth: { mechanism: "none" }, tls: { mode: "auto" }, tunnel: { kind: "none" }, ...over });
const prof = (name: string, over: Partial<ProfileView> = {}): ProfileView =>
  ({ id: name, name, environment: "local", host: "127.0.0.1:27017", favorite: false, group: null, domain: "generic", lastUsedMs: null, spec: spec(), ...over }) as ProfileView;

describe("sectionsOf", () => {
  const list = [prof("zeta"), prof("alpha", { group: "Acme" }), prof("beta", { group: "Acme", favorite: true }), prof("gamma", { group: "Beta group" }), prof("delta", { environment: "production", host: "db.acme.example:27017" })];

  it("puts favourites first (listed once), then groups A to Z, then the ungrouped", () => {
    const s = sectionsOf(list);
    expect(s.map((x) => x.key)).toEqual(["favorites", "g:Acme", "g:Beta group", "none"]);
    expect(s[0].items.map((p) => p.name)).toEqual(["beta"]);
    expect(s[1].items.map((p) => p.name)).toEqual(["alpha"]);
    expect(s[3].items.map((p) => p.name)).toEqual(["delta", "zeta"]);
    expect(s.flatMap((x) => x.items)).toHaveLength(list.length);
  });

  it("filters by search text (name, host, tag, group) and by tag", () => {
    expect(sectionsOf(list, { query: "acme" }).flatMap((x) => x.items.map((p) => p.name)).sort()).toEqual(["alpha", "beta", "delta"]);
    expect(sectionsOf(list, { tag: "production" }).flatMap((x) => x.items.map((p) => p.name))).toEqual(["delta"]);
    expect(sectionsOf(list, { query: "nothing here" })).toEqual([]);
    expect(matchesQuery(prof("x"), "")).toBe(true);
  });

  it("lists groups and toggles collapsed keys", () => {
    expect(allGroups(list)).toEqual(["Acme", "Beta group"]);
    expect(toggled(["a"], "b")).toEqual(["a", "b"]);
    expect(toggled(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("card chips and endpoints", () => {
  it("reads tunnel, TLS and preset from the spec", () => {
    expect(chipsOf(prof("a", { domain: "happy", spec: spec({ tunnel: { kind: "ssh", host: "b", user: "u" } as never, tls: { mode: "on" } }) }))).toEqual({ tunnel: "ssh", tls: "on", preset: "happy" });
    expect(chipsOf(prof("a"))).toEqual({ tunnel: undefined, tls: "auto", preset: "generic" });
  });

  it("lists every outbound endpoint: database hosts, bastion, proxy", () => {
    expect(endpointsOf(spec({ hosts: [{ host: "db1.internal" }, { host: "db2.internal", port: 27018 }], tunnel: { kind: "ssh", host: "bastion.example.com", user: "u" } as never }))).toEqual(["db1.internal:27017", "db2.internal:27018", "bastion.example.com:22"]);
    expect(endpointsOf(spec({ tunnel: { kind: "socks5", host: "proxy.example.com", port: 1080 } as never }))).toEqual(["127.0.0.1:27017", "proxy.example.com:1080"]);
    expect(endpointsOf(spec({ scheme: "srv", hosts: [{ host: "cluster0.k3x9q.mongodb.net" }] }))).toEqual(["cluster0.k3x9q.mongodb.net"]);
    expect(endpointsOf(undefined)).toEqual([]);
  });

  it("asks the first-connect confirmation only for never-used profiles that reach beyond plain loopback", () => {
    expect(needsEndpointConfirm(prof("local"))).toBe(false);
    expect(needsEndpointConfirm(prof("remote", { spec: spec({ hosts: [{ host: "db.example.com" }] }) }))).toBe(true);
    expect(needsEndpointConfirm(prof("tunnel", { spec: spec({ tunnel: { kind: "ssh", host: "b", user: "u" } as never }) }))).toBe(true);
    expect(needsEndpointConfirm(prof("plain", { spec: spec({ auth: { mechanism: "plain" } }) }))).toBe(true);
    expect(needsEndpointConfirm(prof("tlsoff", { spec: spec({ tls: { mode: "off" } }) }))).toBe(true);
    expect(needsEndpointConfirm(prof("used", { lastUsedMs: 1, spec: spec({ hosts: [{ host: "db.example.com" }] }) }))).toBe(false);
  });
});

describe("small decisions", () => {
  it("recognises a rejected sign-in", () => {
    expect(isAuthFailure("Authentication failed.")).toBe(true);
    expect(isAuthFailure("sign-in was rejected")).toBe(true);
    expect(isAuthFailure("connection refused")).toBe(false);
    expect(isAuthFailure(undefined)).toBe(false);
  });

  it("finds connections that vanished without being closed on purpose", () => {
    const c = (id: string) => ({ id });
    expect(vanished([c("a"), c("b"), c("c")], [c("a")], new Set(["b"]))).toEqual(["c"]);
    expect(vanished([c("a")], [c("a")], new Set())).toEqual([]);
  });

  it("maps checked rows to import indexes and knows the note codes", () => {
    expect(selectedIndexes([true, false, true])).toEqual([0, 2]);
    expect(noteKnown("proxy")).toBe(true);
    expect(noteKnown("whatever")).toBe(false);
  });
});
