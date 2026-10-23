import { describe, expect, it } from "vitest";
import { ago, DEFAULT_QUERY, fixTitleStart, levelTone, sameList, shortCount } from "./logic";
import type { SentryIssue } from "./types";

const issue: SentryIssue = {
  id: "11", shortId: "SHOP-B", title: "TypeError: Cannot read properties of undefined (reading 'id')", culprit: "src/api/orders.js in loadOrder", level: "error", status: "unresolved",
  count: 412, userCount: 63, firstSeen: "2026-09-25T10:00:00Z", lastSeen: "2026-10-07T20:00:00Z", permalink: "https://sentry.io/organizations/acme/issues/11/",
  project: { id: "5", slug: "shop-backend", name: "Shop Backend" }, assignedTo: null, errorType: "TypeError", errorValue: "Cannot read", isUnhandled: true,
};

describe("small helpers", () => {
  it("names the start of a fix run after the issue", () => {
    expect(fixTitleStart(issue)).toBe("Fix the Sentry issue SHOP-B");
  });

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
