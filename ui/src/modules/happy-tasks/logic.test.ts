import { describe, expect, it } from "vitest";
import type { TaskItem, TasksView } from "../../ipc/happy";
import { agentPrompt, branchName, DEFAULT_BRANCH_TEMPLATE, dueLabel, groupByStatus, matches, openCount, pickRepoIds, slug } from "./logic";

const task = (over: Partial<TaskItem> = {}): TaskItem => ({ id: "t1", key: "HP-142", title: "Receipts: print the VAT line", status: "s_todo", project: "Shop POS", projectId: "p_pos", ...over });

describe("slug", () => {
  it("makes lowercase ascii words and drops Hungarian accents", () => {
    expect(slug("Receipts: print the VAT line")).toBe("receipts-print-the-vat-line");
    expect(slug("Árvíztűrő tükörfúrógép!")).toBe("arvizturo-tukorfurogep");
    expect(slug("  ---  ")).toBe("");
  });

  it("cuts at a word boundary and never ends with a dash", () => {
    const s = slug("Árvíztűrő tükörfúrógép — teljes körű átállás a számlázóban");
    expect(s).toBe("arvizturo-tukorfurogep-teljes-koru");
    expect(slug("a".repeat(100))).toHaveLength(40);
  });
});

describe("branchName", () => {
  it("fills the default template from the key and the title", () => {
    expect(DEFAULT_BRANCH_TEMPLATE).toBe("feature/{key}-{slug}");
    expect(branchName(DEFAULT_BRANCH_TEMPLATE, task())).toBe("feature/HP-142-receipts-print-the-vat-line");
    expect(branchName("", task())).toBe("feature/HP-142-receipts-print-the-vat-line");
  });

  it("falls back to the id when there is no key, and knows {id} and {project}", () => {
    expect(branchName("{project}/{id}", task({ key: null, id: "t_receipts" }))).toBe("shop-pos/t_receipts");
    expect(branchName("feature/{key}-{slug}", task({ key: undefined, id: "42" }))).toBe("feature/42-receipts-print-the-vat-line");
  });

  it("always yields a valid git ref name", () => {
    expect(branchName("x/{foo}-{slug}", task())).toBe("x/receipts-print-the-vat-line");
    expect(branchName("fix/{slug}/../x", task())).toBe("fix/receipts-print-the-vat-line/x");
    expect(branchName("{key}", task({ key: "HP 142?*" }))).toBe("HP-142");
    expect(branchName("{nothing}", task({ id: "t1" }))).toBe("task-t1");
    for (const name of [branchName("a b/c~d^e:f", task()), branchName("{slug}.lock", task()), branchName("//{slug}//", task()), branchName("a@{b}", task())]) {
      expect(name).not.toMatch(/[\s~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$|\.lock$|^-/);
    }
  });
});

describe("grouping and search", () => {
  const view: TasksView = {
    loaded: true,
    stale: false,
    statuses: [
      { id: "s_done", name: "Done", order: 4, done: true },
      { id: "s_todo", name: "To do", order: 1, done: false },
      { id: "s_doing", name: "In progress", order: 2, done: false },
      { id: "s_empty", name: "Empty", order: 3, done: false },
    ],
    tasks: [task({ id: "a", status: "s_doing", title: "Alpha" }), task({ id: "b", status: "s_todo", title: "Beta" }), task({ id: "c", status: "s_done", title: "Gamma" }), task({ id: "d", status: "s_todo", title: "Delta", project: "Admin", key: "ADM-1" })],
  };

  it("orders groups by the server's status order, hides finished ones and counts them", () => {
    const { groups, hiddenDone } = groupByStatus(view, "", false);
    expect(groups.map((g) => [g.status.id, g.tasks.map((t) => t.id)])).toEqual([["s_todo", ["b", "d"]], ["s_doing", ["a"]]]);
    expect(hiddenDone).toBe(1);
    expect(groupByStatus(view, "", true).groups.map((g) => g.status.id)).toEqual(["s_todo", "s_doing", "s_done"]);
  });

  it("counts the tasks that are not in a finished status", () => {
    expect(openCount(view)).toBe(3);
    expect(openCount({ ...view, tasks: [] })).toBe(0);
  });

  it("filters by every word in key, title, project or status, ignoring accents", () => {
    expect(groupByStatus(view, "adm", false).groups.flatMap((g) => g.tasks.map((t) => t.id))).toEqual(["d"]);
    expect(groupByStatus(view, "progress alpha", false).groups.flatMap((g) => g.tasks.map((t) => t.id))).toEqual(["a"]);
    expect(matches(task({ title: "Számlázó" }), "To do", "szamlazo")).toBe(true);
    expect(matches(task(), "To do", "nope")).toBe(false);
    expect(groupByStatus(view, "zzz", true).groups).toEqual([]);
  });
});

describe("dueLabel", () => {
  const now = Date.UTC(2026, 9, 3, 12);
  it("says overdue, today, tomorrow and in N days", () => {
    expect(dueLabel(undefined, now)).toBeUndefined();
    expect(dueLabel(now - 2 * 86_400_000, now)).toEqual({ text: "overdue 2 d", overdue: true });
    expect(dueLabel(now + 3_600_000, now)).toEqual({ text: "due today", overdue: false });
    expect(dueLabel(now + 86_400_000, now)?.text).toBe("due tomorrow");
    expect(dueLabel(now + 5 * 86_400_000, now)?.text).toBe("due in 5 d");
  });
});

describe("pickRepoIds", () => {
  const repos = [
    { id: "r1", name: "shop-backend" },
    { id: "r2", name: "admin" },
    { id: "r3", name: "shop-mobile" },
    { id: "r4", name: "shop-pos" },
  ];

  it("matches a project to the one repository with the same name", () => {
    expect(pickRepoIds({ project: "Admin" }, {}, repos)).toEqual(["r2"]);
    expect(pickRepoIds({ project: "Shop POS" }, {}, repos)).toEqual(["r4"]);
    expect(pickRepoIds({ project: "Shop Mobile" }, {}, repos)).toEqual(["r3"]);
  });

  it("prefers the explicit mapping, then the repository the server names", () => {
    expect(pickRepoIds({ project: "Happy Backend" }, { "Happy Backend": "shop-backend" }, repos)).toEqual(["r1"]);
    expect(pickRepoIds({ project: "Anything", repo: "shop-backend" }, {}, repos)).toEqual(["r1"]);
    expect(pickRepoIds({ project: "Admin" }, { Admin: "shop-pos" }, repos)).toEqual(["r4"]);
  });

  it("never guesses between several or on a short name", () => {
    expect(pickRepoIds({ project: "Happy Backend" }, {}, repos)).toEqual([]);
    expect(pickRepoIds({ project: "App" }, {}, repos)).toEqual([]);
    expect(pickRepoIds({ project: "Happy" }, {}, repos)).toEqual([]);
    expect(pickRepoIds({}, {}, repos)).toEqual([]);
    expect(pickRepoIds({ project: "Admin" }, { Admin: "no-such-repo" }, repos)).toEqual(["r2"]);
  });
});

describe("agentPrompt", () => {
  it("carries the task, its facts and the branch, and tells the agent not to commit", () => {
    const now = Date.UTC(2026, 9, 3, 12);
    const text = agentPrompt(task({ priority: "high", dueMs: now + 86_400_000, description: "Print the VAT line." }), "In progress", "feature/HP-142-x", now);
    expect(text).toContain("Work on the Happy task HP-142: Receipts: print the VAT line");
    expect(text).toContain("Project: Shop POS");
    expect(text).toContain("Status: In progress");
    expect(text).toContain("Priority: high");
    expect(text).toContain("Due: tomorrow");
    expect(text).toContain("Task description:\nPrint the VAT line.");
    expect(text).toContain("Branch name for this task: feature/HP-142-x");
    expect(text).toMatch(/Do not commit or push/);
  });

  it("works for a bare task", () => {
    const text = agentPrompt({ id: "x", title: "Bare", status: "s" }, "To do", "task-x", 0);
    expect(text.startsWith("Work on the Happy task Bare")).toBe(true);
    expect(text).not.toContain("Task description");
  });
});
