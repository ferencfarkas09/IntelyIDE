import { describe, expect, it } from "vitest";
import { createMockSentry, problemOf } from "./api";
import { DEFAULT_QUERY } from "./logic";

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

describe("problemOf", () => {
  it("reads an engine error, with the pause a rate limit asks for", () => {
    expect(problemOf({ code: "rateLimited", message: "slow", detail: "retryAfterSeconds=17" })).toEqual({ code: "rateLimited", message: "slow", retryAfterSeconds: 17 });
    expect(problemOf({ code: "notFound", message: "x" })).toEqual({ code: "notFound", message: "x" });
    expect(problemOf("boom")).toEqual({ code: "unknown", message: "boom" });
    expect(problemOf(undefined).code).toBe("unknown");
  });
});

describe("the browser fixture", () => {
  const all = async (over = {}) => (await createMockSentry(NOW).issues({ ...DEFAULT_QUERY, status: "all", period: "90d", limit: 100, ...over })).issues;

  it("filters the way the server does: status, period, project, words and level", async () => {
    const sentry = createMockSentry(NOW);
    const unresolved = (await sentry.issues({ ...DEFAULT_QUERY, limit: 100 })).issues;
    expect(unresolved.length).toBeGreaterThan(5);
    expect(unresolved.every((i) => i.status === "unresolved")).toBe(true);
    expect((await all()).length).toBeGreaterThan(unresolved.length);
    expect((await all({ status: "resolved" })).every((i) => i.status === "resolved")).toBe(true);
    expect((await all({ period: "24h" })).every((i) => NOW - Date.parse(i.lastSeen) <= 24 * 3_600_000)).toBe(true);
    expect((await all({ project: "6" })).every((i) => i.project?.id === "6")).toBe(true);
    expect((await all({ query: "chunk" })).every((i) => i.title.toLowerCase().includes("chunk"))).toBe(true);
    expect((await all({ query: "level:fatal" })).every((i) => i.level === "fatal")).toBe(true);
    expect(await all({ query: "no such words anywhere" })).toEqual([]);
  });

  it("sorts and pages: the next page continues where the first stopped and the last has no cursor", async () => {
    const sentry = createMockSentry(NOW);
    const q = { ...DEFAULT_QUERY, status: "all" as const, period: "90d" as const, sort: "freq" as const, limit: 10 };
    const first = await sentry.issues(q);
    expect(first.issues).toHaveLength(10);
    expect(first.issues.map((i) => i.count)).toEqual([...first.issues.map((i) => i.count)].sort((a, b) => b - a));
    expect(first.nextCursor).toBe("0:10:0");
    const second = await sentry.issues({ ...q, cursor: first.nextCursor });
    expect(second.issues.some((i) => first.issues.some((f) => f.id === i.id))).toBe(false);
    let page = second;
    let n = 20;
    while (page.nextCursor) {
      page = await sentry.issues({ ...q, cursor: page.nextCursor });
      n += page.issues.length;
    }
    expect(n).toBe((await all({ sort: "freq" })).length);
  });

  it("reads an issue with its newest event, assigns it to me and changes its status", async () => {
    const sentry = createMockSentry(NOW);
    const [first] = (await sentry.issues({ ...DEFAULT_QUERY })).issues;
    const d = await sentry.issue(first.id);
    expect(d.event?.exceptions[0].frames.some((f) => f.inApp)).toBe(true);
    expect((await sentry.assignMe(first.id)).assignedTo?.name).toBe("Ferenc Farkas");
    expect((await sentry.issue(first.id)).issue.assignedTo?.name).toBe("Ferenc Farkas");
    expect((await sentry.setStatus(first.id, "resolved")).status).toBe("resolved");
    expect((await sentry.issues({ ...DEFAULT_QUERY, limit: 100 })).issues.some((i) => i.id === first.id)).toBe(false);
    await expect(sentry.issue("nope")).rejects.toMatchObject({ code: "notFound" });
  });

  it("is configured out of the box and follows the settings it is given", async () => {
    const sentry = createMockSentry(NOW);
    expect((await sentry.status()).configured).toBe(true);
    expect((await sentry.clearToken()).configured).toBe(false);
    expect((await sentry.test()).problem?.code).toBe("notConfigured");
    expect((await sentry.saveToken("  ")).ok).toBe(false);
    expect((await sentry.saveToken("sntrys_x")).ok).toBe(true);
    expect((await sentry.setConfig({ org: "" })).configured).toBe(false);
    expect((await sentry.setConfig({ org: "acme", baseUrl: "" })).baseUrl).toBe("https://sentry.io");
  });
});
