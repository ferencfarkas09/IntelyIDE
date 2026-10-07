import { describe, expect, it } from "vitest";
import cases from "./url-cases.json";
import { DEVICES, ENV_TONE, ENVS, defaultRepoState, deviceById, fitScale, frameSize, parseRepoState, routeUrl, scaleFor, validatePreviewUrl, viaProxy, withCacheBust } from "./logic";

const ok = (input: string, selfOrigin?: string) => {
  const r = validatePreviewUrl(input, selfOrigin);
  if (!r.ok) throw new Error(`${input} was refused: ${r.reason}`);
  return r;
};
const reason = (input: string, selfOrigin?: string) => {
  const r = validatePreviewUrl(input, selfOrigin);
  return r.ok ? `ACCEPTED ${r.url}` : r.reason;
};

describe("validatePreviewUrl: accepted", () => {
  it("normalises the three literal loopback hosts", () => {
    expect(ok("http://localhost:8082").url).toBe("http://localhost:8082/");
    expect(ok("http://127.0.0.1:19006/auth/signin?x=1#top").url).toBe("http://127.0.0.1:19006/auth/signin?x=1#top");
    expect(ok("HTTP://LOCALHOST:8080/Path").url).toBe("http://localhost:8080/Path");
    expect(ok("http://localhost/").port).toBe(80);
    expect(ok("http://localhost:80/").url).toBe("http://localhost/");
  });

  it("accepts the shorthands people type", () => {
    expect(ok("8082").url).toBe("http://localhost:8082/");
    expect(ok(":8080/sale").url).toBe("http://localhost:8080/sale");
    expect(ok("localhost:19006").url).toBe("http://localhost:19006/");
    expect(ok("127.0.0.1").url).toBe("http://127.0.0.1/");
    expect(ok("  http://localhost:8082/a  ").url).toBe("http://localhost:8082/a");
  });

  it("keeps an @ or a backslash-free odd path as path text, never as a host", () => {
    expect(ok("http://localhost:8082/@evil.com/x").url).toBe("http://localhost:8082/@evil.com/x");
    expect(ok("http://localhost:8082/a?next=http://evil.com").origin).toBe("http://localhost:8082");
  });

  it("returns the origin and port", () => {
    expect(ok("http://127.0.0.1:8082/x")).toMatchObject({ origin: "http://127.0.0.1:8082", port: 8082, host: "127.0.0.1" });
  });
});

describe("validatePreviewUrl: refused", () => {
  it("refuses remote hosts and every scheme but http", () => {
    expect(reason("http://example.com")).toBe("notLoopback");
    expect(reason("https://example.com")).toBe("scheme");
    expect(reason("https://localhost:8082")).toBe("scheme");
    expect(reason("file:///etc/passwd")).toBe("scheme");
    expect(reason("javascript:alert(1)")).toBe("scheme");
    expect(reason("data:text/html,<script>1</script>")).toBe("scheme");
    expect(reason("ftp://localhost")).toBe("scheme");
    expect(reason("ws://localhost:8082")).toBe("scheme");
    expect(reason("//evil.com/x")).toBe("notLoopback");
    expect(reason("example.com")).toBe("notLoopback");
    expect(reason("")).toBe("empty");
    expect(reason("   ")).toBe("empty");
  });

  it("refuses DNS-rebinding style hostnames that resolve to loopback", () => {
    for (const host of [
      "[::1]",
      "127.0.0.1.nip.io",
      "localtest.me",
      "lvh.me",
      "foo.localhost",
      "app.localhost",
      "localhost.evil.com",
      "evil.com.localhost",
      "127.0.0.1.evil.com",
      "localhost.",
      "0.0.0.0",
      "127.0.0.2",
      "127.1",
      "2130706433",
      "0x7f.0.0.1",
      "0177.0.0.1",
      "[::ffff:127.0.0.1]",
      "[0:0:0:0:0:0:0:1]",
      "[::]",
    ]) {
      expect(reason(`http://${host}:8082/`), host).toBe("notLoopback");
    }
  });

  it("refuses userinfo tricks", () => {
    expect(reason("http://localhost@evil.com/")).toBe("credentials");
    expect(reason("http://127.0.0.1:8082@evil.com/")).toBe("credentials");
    expect(reason("http://user:pass@localhost:8082/")).toBe("credentials");
    expect(reason("http://evil.com#@localhost:8082/")).toBe("notLoopback");
    expect(reason("http://evil.com?@localhost:8082/")).toBe("notLoopback");
    expect(reason("http://evil.com/@localhost:8082")).toBe("notLoopback");
  });

  it("refuses backslashes, control characters, spaces and non-ASCII host text", () => {
    expect(reason("http://localhost:8082\\@evil.com")).toBe("badChars");
    expect(reason("http://evil.com\\.localhost:8082")).toBe("badChars");
    expect(reason("http://localhost:8082/a b")).toBe("badChars");
    expect(reason("http://localhost:8082/a\nb")).toBe("badChars");
    expect(reason("http://localhost:8082/\u0000")).toBe("badChars");
    expect(reason("http://ⓛocalhost:8082")).toBe("badChars");
    expect(reason("http://localhost。:8082")).toBe("badChars");
    expect(reason("http://localhost：8082@evil.com")).toBe("credentials");
  });

  it("refuses bad ports and the IDE's own origin", () => {
    expect(reason("http://localhost:0")).toBe("badPort");
    expect(reason("http://localhost:65536")).toBe("badPort");
    expect(reason("http://localhost:99999")).toBe("badPort");
    expect(reason("http://localhost:123456")).toBe("badPort");
    expect(reason("http://localhost:abc")).toBe("badPort");
    expect(reason("http://localhost:")).toBe("badPort");
    expect(reason("http://localhost:1420")).toBe("selfOrigin");
    expect(reason("http://127.0.0.1:1420/x")).toBe("selfOrigin");
    expect(reason("http://localhost:5173", "http://localhost:5173")).toBe("selfOrigin");
    expect(reason("http://localhost:8082", "http://localhost:5173")).toBe("ACCEPTED http://localhost:8082/");
    expect(reason("http://localhost:8082", "tauri://localhost")).toBe("ACCEPTED http://localhost:8082/");
    expect(reason("http://localhost:8082", "null")).toBe("ACCEPTED http://localhost:8082/");
  });

  it("refuses a string that is far too long", () => {
    expect(reason(`http://localhost:8082/${"a".repeat(3000)}`)).toBe("tooLong");
  });

  it("gives every refusal a message", () => {
    for (const bad of ["http://evil.com", "https://localhost", "", "http://localhost:0", "http://a@localhost"]) {
      const r = validatePreviewUrl(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message.length).toBeGreaterThan(10);
    }
  });
});

describe("shared URL cases (the Rust gate runs the same file)", () => {
  type Case = { input: string; ok: boolean; url?: string; reason?: string };
  it.each((cases as { cases: Case[] }).cases.map((c) => [c.input.slice(0, 70).replace(/[^\x20-\x7e]/g, "?"), c] as const))("%s", (_name, c) => {
    const r = validatePreviewUrl(c.input);
    if (c.ok) expect(r).toMatchObject({ ok: true, url: c.url });
    else expect(r).toMatchObject({ ok: false, reason: c.reason });
  });
});

describe("routes, reload, devices", () => {
  it("joins an origin and a route with one slash", () => {
    expect(routeUrl("http://localhost:8082", "/crm/leads")).toBe("http://localhost:8082/crm/leads");
    expect(routeUrl("http://localhost:8082/", "crm/leads")).toBe("http://localhost:8082/crm/leads");
  });

  it("adds a cache-busting parameter before the hash", () => {
    expect(withCacheBust("http://localhost:8082/a", 3)).toBe("http://localhost:8082/a?__ide_reload=3");
    expect(withCacheBust("http://localhost:8082/a?x=1#h", 3)).toBe("http://localhost:8082/a?x=1&__ide_reload=3#h");
  });

  it("moves a page onto the proxy's origin and keeps its path, query and hash", () => {
    expect(viaProxy("http://localhost:8082/crm/leads?x=1#h", "http://127.0.0.1:51234/")).toBe("http://127.0.0.1:51234/crm/leads?x=1#h");
    expect(viaProxy("http://localhost:8082/", "http://127.0.0.1:51234/")).toBe("http://127.0.0.1:51234/");
    expect(viaProxy("http://localhost:8082/a", "not a url")).toBe("http://localhost:8082/a");
  });

  it("lists phone, tablet and desktop presets with unique ids", () => {
    expect(new Set(DEVICES.map((d) => d.id)).size).toBe(DEVICES.length);
    expect(deviceById("iphone-15")).toMatchObject({ width: 393, height: 852 });
    expect(DEVICES.some((d) => d.kind === "tablet") && DEVICES.some((d) => d.kind === "desktop")).toBe(true);
    expect(deviceById("nope").id).toBe("fluid");
  });

  it("rotates: a phone goes landscape, a desktop preset goes portrait, fluid has no size", () => {
    expect(frameSize(deviceById("iphone-15"), false)).toEqual({ width: 393, height: 852 });
    expect(frameSize(deviceById("iphone-15"), true)).toEqual({ width: 852, height: 393 });
    expect(frameSize(deviceById("laptop"), false)).toEqual({ width: 1280, height: 800 });
    expect(frameSize(deviceById("laptop"), true)).toEqual({ width: 800, height: 1280 });
    expect(frameSize(deviceById("fluid"), true)).toBeNull();
    expect(frameSize(deviceById("custom"), false, { width: 5000, height: 10 })).toEqual({ width: 4000, height: 200 });
  });

  it("fits a frame to the pane and never enlarges it", () => {
    expect(fitScale(393, 852, 800, 600)).toBeCloseTo((600 - 24) / 852, 5);
    expect(fitScale(300, 300, 2000, 2000)).toBe(1);
    expect(fitScale(0, 0, 100, 100)).toBe(1);
    expect(scaleFor("fit", { width: 1280, height: 800 }, { width: 640, height: 600 })).toBeLessThan(0.5);
    expect(scaleFor(1.25, { width: 1280, height: 800 }, { width: 640, height: 600 })).toBe(1.25);
    expect(scaleFor("fit", null, { width: 640, height: 600 })).toBe(1);
  });
});

describe("environment and persisted state", () => {
  it("marks production as the danger tone and an unset environment as a warning", () => {
    expect(ENV_TONE.production).toBe("danger");
    expect(ENV_TONE.unset).toBe("warn");
    expect(ENVS).toContain("sandbox");
  });

  it("parses stored state field by field and drops a bad URL", () => {
    expect(parseRepoState(undefined)).toEqual(defaultRepoState());
    const s = parseRepoState({ url: "http://localhost:8082/crm/leads", device: "iphone-15", rotated: true, zoom: 0.75, env: "production", envNote: "api.example", scheme: "light", list: false, custom: { width: 10, height: 99999 } });
    expect(s).toMatchObject({ url: "http://localhost:8082/crm/leads", device: "iphone-15", rotated: true, zoom: 0.75, env: "production", envNote: "api.example", scheme: "light", list: false, custom: { width: 200, height: 4000 } });
    expect(parseRepoState({ url: "https://evil.com", device: "tv", zoom: 9, env: "moon" })).toEqual(defaultRepoState());
    expect(parseRepoState({ url: "http://evil.com" }).url).toBe("");
  });
});
