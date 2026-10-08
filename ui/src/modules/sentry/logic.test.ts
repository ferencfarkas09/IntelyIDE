import { describe, expect, it } from "vitest";
import { ago, DEFAULT_QUERY, fixPrompt, fixTitleStart, levelTone, sameList, shortCount } from "./logic";
import type { SentryDetail, SentryIssue } from "./types";

const issue: SentryIssue = {
  id: "11", shortId: "SHOP-B", title: "TypeError: Cannot read properties of undefined (reading 'id')", culprit: "src/api/orders.js in loadOrder", level: "error", status: "unresolved",
  count: 412, userCount: 63, firstSeen: "2026-09-25T10:00:00Z", lastSeen: "2026-10-07T20:00:00Z", permalink: "https://sentry.io/organizations/acme/issues/11/",
  project: { id: "5", slug: "shop-backend", name: "Shop Backend" }, assignedTo: null, errorType: "TypeError", errorValue: "Cannot read", isUnhandled: true,
};

const detail: SentryDetail = {
  issue,
  event: {
    eventId: "e1", dateCreated: "2026-10-07T20:00:00Z", platform: "node", release: "shop@2026.10.3", environment: "production", message: "boom", tags: [],
    requestUrl: "https://shop.example.invalid/api/orders/7",
    exceptions: [{ kind: "TypeError", value: "x is undefined", frames: [
      { filename: "node_modules/express/router.js", function: "handle", line: 10, inApp: false, context: [] },
      { filename: "src/api/orders.js", function: "loadOrder", line: 42, inApp: true, context: [{ line: 41, code: "const o = await db.find(id);" }, { line: 42, code: "  return o.id;" }] },
    ] }],
    breadcrumbs: [{ timestamp: "t", category: "http", message: "GET /orders/7", level: "info" }],
  },
};

describe("fixPrompt", () => {
  it("names the issue, where it is, how often, the stack with the failing line, the last steps and the rules of the fix", () => {
    const p = fixPrompt(detail);
    expect(p.split("\n")[0]).toBe("Fix the Sentry issue SHOP-B: TypeError: Cannot read properties of undefined (reading 'id')");
    expect(p).toContain("Where: src/api/orders.js in loadOrder (project shop-backend)");
    expect(p).toContain("Seen 412 times by 63 users");
    expect(p).toContain("unhandled");
    expect(p).toContain("Release: shop@2026.10.3, environment production");
    expect(p).toContain("Request: https://shop.example.invalid/api/orders/7");
    expect(p).toContain("TypeError: x is undefined");
    expect(p).toContain("at loadOrder (src/api/orders.js:42)");
    expect(p).toContain("42| return o.id;");
    expect(p).not.toContain("node_modules/express");
    expect(p).toContain("- [http] GET /orders/7");
    expect(p).toContain("Sentry: https://sentry.io/organizations/acme/issues/11/");
    expect(p).toMatch(/Do not commit or push/);
    expect(p.startsWith(fixTitleStart(issue))).toBe(true);
  });

  it("still reads well for an issue whose newest event could not be read, and for one seen once by one user", () => {
    const p = fixPrompt({ issue: { ...issue, count: 1, userCount: 1, isUnhandled: false, project: null }, event: null });
    expect(p).toContain("Seen 1 time by 1 user,");
    expect(p).not.toContain("unhandled");
    expect(p).not.toContain("(project");
    expect(p).toContain("Find the cause in the code");
  });

  it("falls back to the library frames when none is the app's own", () => {
    const only = { ...detail, event: { ...detail.event!, exceptions: [{ kind: "E", value: "v", frames: [{ filename: "lib/a.js", function: "f", line: 1, inApp: false, context: [] }] }] } };
    expect(fixPrompt(only)).toContain("at f (lib/a.js:1)  [library]");
  });
});

describe("small helpers", () => {
  it("colours levels, counts and measures time since", () => {
    expect(["fatal", "error", "warning", "info", "debug"].map(levelTone)).toEqual(["danger", "danger", "warn", "neutral", "neutral"]);
    expect([0, 999, 1500, 25_000, 250_000, 2_500_000].map(shortCount)).toEqual(["0", "999", "1.5k", "25k", "250k", "2.5M"]);
    const now = Date.parse("2026-10-07T12:00:00Z");
    expect(ago("2026-10-07T11:59:30Z", now)).toEqual({ unit: "minute", n: 1 });
    expect(ago("2026-10-07T09:00:00Z", now)).toEqual({ unit: "hour", n: 3 });
    expect(ago("2026-10-04T12:00:00Z", now)).toEqual({ unit: "day", n: 3 });
    expect(ago("2026-10-07T13:00:00Z", now)).toEqual({ unit: "minute", n: 0 });
    expect(ago("never", now)).toBeUndefined();
  });

  it("knows when two queries ask for the same list", () => {
    expect(sameList(DEFAULT_QUERY, { ...DEFAULT_QUERY, query: "  " })).toBe(true);
    expect(sameList(DEFAULT_QUERY, { ...DEFAULT_QUERY, cursor: "0:25:0", limit: 10 })).toBe(true);
    expect(sameList(DEFAULT_QUERY, { ...DEFAULT_QUERY, status: "all" })).toBe(false);
    expect(sameList(DEFAULT_QUERY, { ...DEFAULT_QUERY, project: "5" })).toBe(false);
    expect(sameList(DEFAULT_QUERY, { ...DEFAULT_QUERY, query: "level:error" })).toBe(false);
  });
});
