import { describe, expect, it } from "vitest";
import { activityLine, filterChoices, groupOf, groupSessions, matchesFilter, nextNeedsYou, NO_FILTER, REVIEW_WINDOW_MS } from "./sessionsLogic";
import { PERMISSION, row, viewOf } from "./testing";

const NOW = 10_000_000;

describe("groupOf", () => {
  it("puts live runs first and unopened finished runs under review", () => {
    expect(groupOf(row({ agentId: "a", status: "needsYou" }), new Set(), NOW)).toBe("needsYou");
    expect(groupOf(row({ agentId: "a", status: "running" }), new Set(), NOW)).toBe("running");
    expect(groupOf(row({ agentId: "a", status: "done", startedAt: NOW - 1000 }), new Set(), NOW)).toBe("review");
    expect(groupOf(row({ agentId: "a", status: "error", startedAt: NOW - 1000 }), new Set(), NOW)).toBe("review");
  });

  it("moves a run to Done once it was opened or is older than a day", () => {
    expect(groupOf(row({ agentId: "a", status: "done", startedAt: NOW - 1000 }), new Set(["a"]), NOW)).toBe("done");
    expect(groupOf(row({ agentId: "a", status: "done", startedAt: NOW - REVIEW_WINDOW_MS - 1 }), new Set(), NOW)).toBe("done");
  });
});

describe("groupSessions", () => {
  const rows = [
    row({ agentId: "1", status: "done", role: "reviewer", repoIds: ["backend"], startedAt: NOW - 5000 }),
    row({ agentId: "2", status: "running", startedAt: NOW - 3000 }),
    row({ agentId: "3", status: "running", startedAt: NOW - 1000 }),
    row({ agentId: "4", status: "needsYou", repoIds: ["admin", "backend"] }),
  ];

  it("returns non-empty groups in order, newest first", () => {
    const groups = groupSessions(rows, NO_FILTER, new Set(), NOW);
    expect(groups.map((g) => g.id)).toEqual(["needsYou", "running", "review"]);
    expect(groups[1].rows.map((r) => r.agentId)).toEqual(["3", "2"]);
  });

  it("filters by role and by repo", () => {
    expect(groupSessions(rows, { role: "reviewer", repoId: "" }, new Set(), NOW).flatMap((g) => g.rows.map((r) => r.agentId))).toEqual(["1"]);
    expect(groupSessions(rows, { role: "", repoId: "backend" }, new Set(), NOW).flatMap((g) => g.rows.map((r) => r.agentId)).sort()).toEqual(["1", "4"]);
    expect(matchesFilter(rows[1], { role: "developer", repoId: "backend" })).toBe(false);
  });

  it("lists the roles and repos that occur", () => {
    expect(filterChoices(rows)).toEqual({ roles: ["developer", "reviewer"], repoIds: ["admin", "backend"] });
  });
});

describe("activityLine", () => {
  it("shows the open request, the running tool, or the last words", () => {
    const asking = viewOf("a", [PERMISSION]);
    expect(activityLine(row({ agentId: "a", status: "needsYou" }), asking)).toBe("Asks: Run npm test");
    const tooling = viewOf("a", [{ kind: "tool.start", toolId: "t1", name: "Grep", toolKind: "search", input: { pattern: "orders" } }]);
    expect(activityLine(row({ agentId: "a" }), tooling)).toMatch(/^Running Grep/);
    const done = viewOf("a", [{ kind: "text.delta", messageId: "m", text: "All **done**.\nBye" }]);
    expect(activityLine(row({ agentId: "a", status: "done" }), done)).toBe("All done. Bye");
  });

  it("says what a run without a view is waiting for", () => {
    expect(activityLine(row({ agentId: "a" }), undefined)).toBe("Starting…");
    expect(activityLine(row({ agentId: "a", status: "done" }), undefined)).toBe("");
  });

  it("names a throttled turn", () => {
    expect(activityLine(row({ agentId: "a", throttle: { state: "throttled", since: 0 } }), viewOf("a", []))).toBe("Throttled by the provider");
  });
});

describe("nextNeedsYou", () => {
  const rows = [row({ agentId: "a", status: "needsYou", startedAt: 1 }), row({ agentId: "b", status: "running" }), row({ agentId: "c", status: "needsYou", startedAt: 2 })];

  it("walks the waiting runs and wraps around", () => {
    expect(nextNeedsYou(rows, null)).toBe("a");
    expect(nextNeedsYou(rows, "a")).toBe("c");
    expect(nextNeedsYou(rows, "c")).toBe("a");
    expect(nextNeedsYou(rows, "b")).toBe("a");
  });

  it("returns nothing when nobody waits", () => {
    expect(nextNeedsYou([rows[1]], null)).toBeUndefined();
  });
});
