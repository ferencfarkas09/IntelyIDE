import { describe, expect, it } from "vitest";
import { createMockGraph } from "./graph";

describe("mock graph", () => {
  it("pages an interleaved log newest first and carries the stripes", async () => {
    const g = createMockGraph();
    const first = await g.logPage(["api", "web"], undefined, undefined, 5);
    expect(first.rows).toHaveLength(5);
    expect(first.nextCursor).toBe("5");
    expect(first.repos.map((r) => r.repoId)).toEqual(["api", "web"]);
    const second = await g.logPage(["api", "web"], first.nextCursor ?? undefined, undefined, 5);
    const dates = [...first.rows, ...second.rows].map((r) => r.dateMs);
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
    expect(second.nextCursor ?? undefined).toBeUndefined();
  });

  it("refuses the plans the real backend refuses", async () => {
    const g = createMockGraph();
    const plan = await g.rebasePlan("api", "main");
    expect((await g.rebaseRun(plan)).status).toBe("done");
    plan.steps[0].action = "squash";
    await expect(g.rebaseRun(plan)).rejects.toMatchObject({ code: "invalidArgument" });
  });

  it("validates a conventional header", async () => {
    const g = createMockGraph();
    expect((await g.validateMessage("feat(crm): add x", "conventional")).ok).toBe(true);
    expect((await g.validateMessage("added x", "conventional")).issues[0].code).toBe("header.format");
  });
});
