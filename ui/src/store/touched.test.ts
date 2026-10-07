import { afterEach, describe, expect, it } from "vitest";
import { createMockIpc } from "../ipc/mock";
import { fixtureEvents } from "../ipc/mock/runsFixtures";
import { emptyView, reduceEvents } from "./agent-reducer";
import { agentView, resetAgents, selectedAgentId, startAgentStore } from "./agents";
import { dismissTouched, resolveRepoPath, touchedByAgent, touchedPaths } from "./touched";

const ROOTS = [{ id: "admin", path: "/Users/example/Projects/admin" }];

describe("touchedPaths", () => {
  const view = reduceEvents(emptyView("run-dev"), fixtureEvents("run-dev")!);

  it("lists the files of finished edit tools, resolved to their repo", () => {
    const paths = touchedPaths(view, { repoIds: ["admin"], roots: ROOTS });
    expect(paths).toEqual([
      { repoId: "admin", path: "src/components/modules/orders/OrdersTable.tsx" },
      { repoId: "admin", path: "src/components/layout/Header.tsx" },
      { repoId: "admin", path: "src/api/services/loyaltyService.js" },
    ]);
  });

  it("skips edits that failed or were denied, and reads outside every repo as untracked", () => {
    const failed = reduceEvents(emptyView("x"), fixtureEvents("run-dev")!.map((e) => (e.kind === "tool.result" && e.toolId === "t4" ? { ...e, status: "denied" as const } : e)));
    expect(touchedPaths(failed, { repoIds: ["admin"], roots: ROOTS }).map((p) => p.path)).not.toContain("src/components/modules/orders/OrdersTable.tsx");
    expect(resolveRepoPath("/tmp/elsewhere/a.ts", ["admin"], ROOTS).repoId).toBeUndefined();
  });

  it("ignores reads and searches", () => {
    const readOnly = reduceEvents(emptyView("y"), fixtureEvents("run-res")!);
    expect(touchedPaths(readOnly, { repoIds: ["admin"], roots: ROOTS })).toEqual([]);
  });
});

describe("touchedByAgent", () => {
  afterEach(resetAgents);

  it("marks a file a finished run edited, until the user has reviewed it", async () => {
    startAgentStore(createMockIpc("agent-normal", { delayScale: 0 }));
    for (let i = 0; i < 400 && !(agentView(selectedAgentId() ?? "")?.items.some((t) => t.type === "tool" && t.name === "Edit" && t.status === "ok") && agentView(selectedAgentId()!)?.turnActive === false); i++) await new Promise((r) => setTimeout(r, 10));
    expect(touchedByAgent("admin", "src/utils/format.ts")).toMatchObject({ role: "developer", active: false });
    expect(touchedByAgent("admin", "src/other.ts")).toBeUndefined();
    dismissTouched([{ repoId: "admin", path: "src/utils/format.ts" }]);
    expect(touchedByAgent("admin", "src/utils/format.ts")).toBeUndefined();
  });
});
