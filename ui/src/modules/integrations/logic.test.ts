import { describe, expect, it } from "vitest";
import type { HappyStatus } from "../../ipc/happy";
import { ago, connectionLine, hostOf, looksLikeToken } from "./logic";

const base: HappyStatus = {
  config: { master: true, env: "sandbox", timer: { enabled: true, showInStatusBar: true, allowActions: true }, meet: { enabled: false, showInStatusBar: true, allowActions: true }, chat: { enabled: false, showInStatusBar: true, allowActions: true }, notifications: { enabled: false, showInStatusBar: true, allowActions: true }, tasks: { enabled: false, showInStatusBar: true, allowActions: true } },
  tokenSaved: true,
  providers: [],
};
const NOW = 1_800_000_000_000;

describe("connectionLine", () => {
  it("says what is missing when there is no token", () => {
    expect(connectionLine({ ...base, tokenSaved: false }, NOW)).toEqual({ tone: "neutral", text: "No token saved. Switched-on integrations wait for one." });
  });
  it("names the user, roles and the last check", () => {
    const line = connectionLine({ ...base, user: { id: "u", name: "Teszt Elek", roles: ["admin", "timeTracker"] }, validatedAtMs: NOW - 2 * 60_000 }, NOW);
    expect(line).toEqual({ tone: "ok", text: "Connected as Teszt Elek · admin, timeTracker · checked 2 min ago" });
  });
  it("shows the expired session above everything else", () => {
    const line = connectionLine({ ...base, signedOut: { code: "DEVICE_LOGGED_OUT", message: "x", atMs: NOW } }, NOW);
    expect(line.tone).toBe("danger");
  });
  it("is calm while loading", () => {
    expect(connectionLine(undefined, NOW).text).toBe("Loading");
  });
});

describe("helpers", () => {
  it("words the age", () => {
    expect(ago(NOW - 10_000, NOW)).toBe("just now");
    expect(ago(NOW - 3 * 3600_000, NOW)).toBe("3 h ago");
    expect(ago(NOW - 49 * 3600_000, NOW)).toBe("2 d ago");
  });
  it("extracts the host and survives garbage", () => {
    expect(hostOf("https://happy.example.test/")).toBe("happy.example.test");
    expect(hostOf("http://127.0.0.1:4010")).toBe("127.0.0.1:4010");
    expect(hostOf("nope")).toBeUndefined();
    expect(hostOf(undefined)).toBeUndefined();
  });
  it("accepts a three-part token and rejects the rest", () => {
    expect(looksLikeToken(" eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln ")).toBe(true);
    for (const bad of ["", "abc", "a.b", "a.b.c.d", "a b.c.d", "Bearer a.b.c"]) expect(looksLikeToken(bad)).toBe(false);
  });
});
