import { describe, expect, it } from "vitest";
import { fixtureEvents } from "../../ipc/mock/runsFixtures";
import { delegationEvents } from "./delegationFixture";
import { buildInspection, resolveRepoPath, sameModel, timelineSpan, visibleTools } from "./model";

const ROOTS = [
  { id: "admin", path: "/Users/example/Projects/admin" },
  { id: "backend", path: "/Users/example/Projects/shop-backend" },
];
const exists = (repo: string, path: string) => (repo === "backend" ? path === "src/api/services/loyaltyService.js" : path === "src/components/layout/Header.tsx");
const devRun = () => buildInspection("run-dev", fixtureEvents("run-dev")!, { repoIds: ["admin", "backend"], roots: ROOTS, exists });

describe("resolveRepoPath", () => {
  it("maps an absolute path to the repo with the longest matching root", () => {
    expect(resolveRepoPath("/Users/example/Projects/admin/src/a.ts", ["admin"], ROOTS)).toEqual({ repoId: "admin", path: "src/a.ts" });
    const nested = [...ROOTS, { id: "inner", path: "/Users/example/Projects/admin/packages/inner" }];
    expect(resolveRepoPath("/Users/example/Projects/admin/packages/inner/x.ts", ["admin"], nested)).toEqual({ repoId: "inner", path: "x.ts" });
  });

  it("does not treat a sibling directory with the same prefix as inside the repo", () => {
    expect(resolveRepoPath("/Users/example/Projects/admin-old/a.ts", ["admin"], ROOTS).repoId).toBeUndefined();
  });

  it("puts a relative path in the first run repo that has it, else the first repo", () => {
    expect(resolveRepoPath("src/api/services/loyaltyService.js", ["admin", "backend"], ROOTS, exists).repoId).toBe("backend");
    expect(resolveRepoPath("./nowhere.ts", ["admin", "backend"], ROOTS, exists)).toEqual({ repoId: "admin", path: "nowhere.ts" });
  });
});

describe("buildInspection", () => {
  it("nests subagent calls under their parent tool and keeps durations", () => {
    const i = devRun();
    const task = i.roots.find((n) => n.toolId === "s1")!;
    expect(task.children.map((c) => c.toolId)).toEqual(["t2", "t3"]);
    expect(task.children[0].depth).toBe(1);
    expect(task.durationMs).toBe(1200);
    expect(i.roots.map((n) => n.toolId)).not.toContain("t2");
    expect(i.tools).toHaveLength(8);
  });

  it("hides the children of a collapsed subagent", () => {
    const i = devRun();
    expect(visibleTools(i, new Set()).map((n) => n.toolId)).toContain("t2");
    expect(visibleTools(i, new Set(["s1"])).map((n) => n.toolId)).not.toContain("t2");
  });

  it("collects the files the run changed with their repo, edits and line counts", () => {
    const files = devRun().files;
    expect(files.map((f) => `${f.repoId}:${f.path}`)).toEqual(["admin:src/components/modules/orders/OrdersTable.tsx", "admin:src/components/layout/Header.tsx", "backend:src/api/services/loyaltyService.js"]);
    const table = files[0];
    expect(table).toMatchObject({ edits: 1, created: false, additions: 3, deletions: 2 });
    expect(files[2].created).toBe(true);
  });

  it("does not count a failed edit as a touched file", () => {
    const events = fixtureEvents("run-dev")!.map((e) => (e.kind === "tool.result" && e.toolId === "t5" ? { ...e, status: "error" as const, diff: undefined } : e));
    const i = buildInspection("run-dev", events, { repoIds: ["admin"], roots: ROOTS });
    expect(i.files.some((f) => f.path.endsWith("Header.tsx"))).toBe(false);
  });

  it("reads the init facts, rss and usage", () => {
    const i = devRun();
    expect(i.init).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium", permission: "edit", auth: { mode: "subscription" }, mcp: [{ name: "github", status: "connected" }, { name: "sentry", status: "needs-auth" }], hooks: ["PreToolUse: agent-gate", "PostToolUse: format-on-save"] });
    expect(i.rssBytes).toBe(468_000_000);
    expect(i.usage?.cumulative.outputTokens).toBe(1480);
    expect(i.finished).toBe(true);
    expect(i.stopReason).toBe("endTurn");
  });

  it("lists provider errors, failed tools and the throttle window", () => {
    const issues = devRun().issues;
    expect(issues.map((x) => x.kind)).toEqual(["toolError", "error", "throttle"]);
    expect(issues[1]).toMatchObject({ class: "network", retryable: true });
    const throttle = issues[2];
    expect(throttle.untilMs! - throttle.atMs).toBe(30_100);
  });

  it("is empty and unfinished for an empty log", () => {
    const i = buildInspection("x", [], { repoIds: [], roots: [] });
    expect(i).toMatchObject({ eventCount: 0, finished: false, tools: [], files: [], issues: [] });
    expect(timelineSpan(i).length).toBe(1);
  });
});

describe("buildInspection: roles of an Auto run", () => {
  const run = () => buildInspection("run-auto", delegationEvents(), { repoIds: ["admin"], roots: ROOTS });

  it("reads the delegate table and gives every call of an Agent call its role and configured model", () => {
    const i = run();
    expect(i.delegates.map((d) => d.name)).toEqual(["researcher", "developer", "reviewer"]);
    const byId = new Map(i.tools.map((n) => [n.toolId, n]));
    expect(byId.get("d1")).toMatchObject({ role: "researcher", model: "claude-haiku-4-5-20251001" });
    expect(byId.get("t1")).toMatchObject({ role: "researcher", model: "claude-haiku-4-5-20251001", actualModel: "claude-haiku-4-5-20251001" });
    expect(byId.get("t3")).toMatchObject({ role: "developer", model: "claude-sonnet-5-5", actualModel: "claude-sonnet-5-5" });
    expect(byId.get("d1")?.actualModel).toBe("claude-haiku-4-5-20251001");
  });

  it("builds the roles table: calls and refusals per role, the Agent call itself is not a call of its role", () => {
    const rows = run().roles;
    expect(rows.map((r) => [r.name, r.calls, r.refused])).toEqual([["researcher", 2, 1], ["developer", 1, 0], ["reviewer", 1, 0]]);
    expect(rows[0]).toMatchObject({ model: "claude-haiku-4-5-20251001", permission: "readOnly", scope: "builtin" });
  });

  it("keeps who refused a call, by which rule and in which role", () => {
    const refused = run().tools.find((n) => n.toolId === "t2")!;
    expect(refused.status).toBe("denied");
    expect(refused.refused).toEqual({ by: "roleDeny", rule: "role.read-only", role: "researcher" });
  });

  it("falls back to the rule named in the refusal text, and to an unknown source", () => {
    const events = delegationEvents().filter((e) => e.kind !== "permission.resolved");
    const t2 = buildInspection("run-auto", events, { repoIds: ["admin"], roots: ROOTS }).tools.find((n) => n.toolId === "t2")!;
    expect(t2.refused).toEqual({ by: "unknown", rule: "role.read-only" });
  });

  it("reads any rule id from the trailing (by, rule) of the broker's text", () => {
    const events = delegationEvents()
      .filter((e) => e.kind !== "permission.resolved")
      .map((e) => (e.kind === "tool.result" && e.toolId === "t2" ? { ...e, output: "INTELY-HARDSTOP: git push is human-only (hardStop, git.push)" } : e));
    const t2 = buildInspection("run-auto", events, { repoIds: ["admin"], roots: ROOTS }).tools.find((n) => n.toolId === "t2")!;
    expect(t2.refused).toEqual({ by: "unknown", rule: "git.push" });
  });

  it("lists the cost per model from the usage record", () => {
    expect(run().costByModel.map((c) => [c.model, c.inputTokens, c.costUsd])).toEqual([["claude-sonnet-5-5", 6000, 0.03], ["claude-haiku-4-5-20251001", 3000, 0.01]]);
  });

  it("raises an issue when a role ran on another model than its definition says", () => {
    const issues = run().issues.filter((i) => i.kind === "modelMismatch");
    expect(issues).toHaveLength(1);
    expect(issues[0].title).toBe("reviewer ran on Opus 5.5, but its role says Sonnet 5.5.");
  });

  it("a run without roles has an empty table, no cost rows and no mismatch", () => {
    const i = devRun();
    expect(i.delegates).toEqual([]);
    expect(i.roles).toEqual([]);
    expect(i.costByModel).toEqual([]);
    expect(i.tools.every((n) => n.role === undefined || n.name === "Task")).toBe(true);
  });
});

describe("sameModel", () => {
  it("treats an alias, a full id and a dated id of one model as the same, and different versions or families as different", () => {
    expect(sameModel("sonnet", "claude-sonnet-5-5")).toBe(true);
    expect(sameModel("claude-haiku-4-5-20251001", "claude-haiku-4-5")).toBe(true);
    expect(sameModel("claude-sonnet-5-5", "claude-sonnet-5-5")).toBe(true);
    expect(sameModel("claude-sonnet-5-5", "claude-sonnet-5-0")).toBe(false);
    expect(sameModel("claude-sonnet-5-5", "claude-opus-5-5")).toBe(false);
    expect(sameModel("opus", "claude-haiku-4-5")).toBe(false);
    expect(sameModel("gpt-x", "gpt-x")).toBe(true);
  });
});

describe("the permission fact follows a live mode switch", () => {
  const started = { agentId: "r", seq: 1, ts: 1, provider: "claude", kind: "session.started", nativeId: "n", model: "claude-sonnet-5-5", effective: { permission: "ask" } };
  const info = (seq: number, permission: string, reason?: string) => ({ agentId: "r", seq, ts: seq, provider: "claude", kind: "session.info", effective: { permission, ...(reason ? { reason } : {}) } });
  const facts = (...events: object[]) => buildInspection("r", events as never, { repoIds: [], roots: [], exists: () => false }).init;

  it("shows the mode the run started in until the session reports another, then the latest", () => {
    expect(facts(started)?.permission).toBe("ask");
    expect(facts(started, info(2, "automatic", "user"))?.permission).toBe("automatic");
    expect(facts(started, info(2, "readOnly", "user"), info(3, "edit", "planApproved"))?.permission).toBe("edit");
  });

  it("leaves the other facts alone, and a mode before the session started is ignored", () => {
    expect(facts(started, info(2, "bypass", "user"))).toMatchObject({ model: "claude-sonnet-5-5", permission: "bypass" });
    expect(facts(info(1, "bypass", "user"))).toBeUndefined();
  });
});
