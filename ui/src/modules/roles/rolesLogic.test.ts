import { describe, expect, it } from "vitest";
import type { Role, RoleProviderCaps } from "../../ipc/roles";
import type { RoleGroup } from "../../ipc/roles";
import { canDelete, clampEffort, deleteErrorText, deleteTargets, derivedEditors, driftRows, effortOptions, excludeReasonText, groupRows, hasIssues, isDirty, modelOptions, newRole, permissionText, reconcile, scopeChips, toolChips, validateRole, warningText } from "./rolesLogic";

const CAPS: RoleProviderCaps[] = [
  {
    provider: "claude",
    label: "Claude",
    models: [
      { id: "haiku", label: "Haiku", effortLevels: [] },
      { id: "sonnet", label: "Sonnet", effortLevels: ["low", "medium", "high"] },
    ],
    permissionModes: ["readOnly", "edit", "ask"],
    tools: ["Read", "Grep", "Edit", "Bash"],
  },
];
const DEV: Role = { id: "developer", name: "developer", provider: "claude", model: "sonnet", effort: "medium", permission: "edit", tools: ["Read", "Edit"] };

describe("validateRole", () => {
  it("accepts a consistent role", () => {
    expect(hasIssues(validateRole(DEV, CAPS, [DEV]))).toBe(false);
  });

  it("flags names, models and efforts the provider does not accept", () => {
    expect(validateRole({ ...DEV, name: "Dev eloper" }, CAPS, []).name).toMatch(/lowercase/);
    expect(validateRole({ ...DEV, id: "x" }, CAPS, [DEV]).name).toMatch(/already/);
    expect(validateRole({ ...DEV, model: "gpt" }, CAPS, []).model).toBeDefined();
    expect(validateRole({ ...DEV, effort: "max" }, CAPS, []).effort).toBeDefined();
    expect(validateRole({ ...DEV, model: "haiku" }, CAPS, []).effort).toMatch(/no effort/);
    expect(validateRole({ ...DEV, model: "haiku", effort: null }, CAPS, []).effort).toBeUndefined();
  });

  it("refuses a read-only role with writing tools and a role without tools", () => {
    expect(validateRole({ ...DEV, permission: "readOnly", tools: ["Read", "Bash"] }, CAPS, []).tools).toMatch(/Bash/);
    expect(validateRole({ ...DEV, tools: [] }, CAPS, []).tools).toMatch(/at least one/);
    expect(validateRole({ ...DEV, tools: ["Fly"] }, CAPS, []).tools).toMatch(/not offered/);
  });
});

describe("validateRole on the user's real role files", () => {
  it("accepts colour names, a claude-* model the catalog lacks and file-only tools", () => {
    const file: Role = { ...DEV, model: "claude-sonnet-4-6", effort: null, color: "yellow", tools: ["Read", "Grep", "WebSearch", "mcp__x__y", "Agent(researcher)"], permission: "readOnly" };
    expect(validateRole(file, CAPS, [])).toEqual({});
    expect(validateRole({ ...file, effort: "high" }, CAPS, [])).toEqual({});
  });

  it("still refuses nonsense", () => {
    expect(validateRole({ ...DEV, color: "not a colour" }, CAPS, []).color).toBeDefined();
    expect(validateRole({ ...DEV, color: "#12" }, CAPS, []).color).toBeDefined();
    expect(validateRole({ ...DEV, model: "gpt-4" }, CAPS, []).model).toBeDefined();
    expect(validateRole({ ...DEV, tools: ["Fly"] }, CAPS, []).tools).toBeDefined();
  });

  it("shows the file's model and tools in the pickers and keeps them on a model change", () => {
    expect(modelOptions([{ id: "haiku", label: "Haiku" }], "claude-sonnet-4-6").map((o) => o.value)).toEqual(["haiku", "claude-sonnet-4-6"]);
    expect(modelOptions([{ id: "haiku", label: "Haiku" }], "haiku")).toHaveLength(1);
    expect(toolChips(["Read"], ["Read", "WebSearch"])).toEqual(["Read", "WebSearch"]);
    expect(reconcile({ ...DEV, tools: ["Read", "WebSearch"] }, CAPS).tools).toEqual(["Read", "WebSearch"]);
  });
});

describe("effort", () => {
  it("reads the levels from the model", () => {
    expect(effortOptions(DEV, CAPS)).toEqual(["low", "medium", "high"]);
    expect(effortOptions({ ...DEV, model: "haiku" }, CAPS)).toEqual([]);
  });

  it("clamps to the nearest accepted level", () => {
    expect(clampEffort("max", ["low", "medium", "high"])).toBe("high");
    expect(clampEffort("low", ["medium", "high"])).toBe("medium");
    expect(clampEffort("high", [])).toBeNull();
  });
});

describe("reconcile", () => {
  it("moves a role onto what the new model offers", () => {
    const next = reconcile({ ...DEV, model: "haiku", effort: "high", permission: "automatic", tools: ["Read", "Fly"] }, CAPS);
    expect(next).toMatchObject({ model: "haiku", effort: null, permission: "readOnly", tools: ["Read"] });
  });
});

describe("drift and dirty state", () => {
  it("lists only the differing fields as display strings", () => {
    const repo: Role = { ...DEV, model: "haiku", effort: null, tools: ["Read"] };
    expect(driftRows(DEV, repo)).toEqual([
      { field: "model", label: "Model", global: "sonnet", repo: "haiku" },
      { field: "effort", label: "Effort", global: "medium", repo: "n/a" },
      { field: "tools", label: "Tools", global: "Read, Edit", repo: "Read" },
    ]);
    expect(driftRows(DEV, { ...DEV })).toEqual([]);
  });

  it("treats a new role and an edited role as dirty", () => {
    expect(isDirty(DEV, undefined)).toBe(true);
    expect(isDirty({ ...DEV }, DEV)).toBe(false);
    expect(isDirty({ ...DEV, tools: ["Read"] }, DEV)).toBe(true);
  });
});

describe("newRole", () => {
  it("picks a free id and a valid starting point", () => {
    const role = newRole(CAPS, ["role-1"]);
    expect(role.id).toBe("role-2");
    expect(hasIssues(validateRole(role, CAPS, []))).toBe(false);
  });
});

const GROUP = (over: Partial<RoleGroup> & { name: string }): RoleGroup => ({
  role: { ...DEV, name: over.name, id: over.name },
  copies: [{ id: over.name, scope: "global", path: "/g", sameAsWinner: true, fieldsDiffer: [] }],
  winnerReason: "onlyCopy",
  conflict: false,
  pinMissing: false,
  hidden: false,
  builtinShadowed: false,
  diffs: [],
  delegate: { ok: true },
  ...over,
});

describe("groups", () => {
  it("sorts by name, keeps hidden ones out unless asked and counts them", () => {
    const gs = [GROUP({ name: "b" }), GROUP({ name: "a", hidden: true }), GROUP({ name: "c" })];
    expect(groupRows(gs, false).rows.map((g) => g.name)).toEqual(["b", "c"]);
    expect(groupRows(gs, false).hiddenCount).toBe(1);
    expect(groupRows(gs, true).rows.map((g) => g.name)).toEqual(["a", "b", "c"]);
  });

  it("chips: Global, one per repository (once), Built-in", () => {
    const g = GROUP({
      name: "x",
      copies: [
        { id: "x", scope: "global", path: "/g", sameAsWinner: true, fieldsDiffer: [] },
        { id: "x@a", scope: "repo", repoId: "a", path: "/a", sameAsWinner: true, fieldsDiffer: [] },
        { id: "x@a2", scope: "repo", repoId: "a", path: "/a2", sameAsWinner: true, fieldsDiffer: [] },
      ],
      builtinShadowed: true,
    });
    expect(scopeChips(g, (id) => id.toUpperCase()).map((c) => c.label)).toEqual(["Global", "A", "Built-in"]);
  });

  it("delete targets: one copy or every copy; a pure built-in has nothing to delete", () => {
    const g = GROUP({ name: "x", copies: [{ id: "x", scope: "global", path: "/g", sameAsWinner: true, fieldsDiffer: [] }, { id: "x@a", scope: "repo", repoId: "a", path: "/a", sameAsWinner: false, fieldsDiffer: ["model"] }] });
    expect(deleteTargets(g)).toEqual(["x", "x@a"]);
    expect(deleteTargets(g, "x@a")).toEqual(["x@a"]);
    expect(canDelete(g)).toBe(true);
    expect(canDelete({ copies: [] })).toBe(false);
  });
});

describe("permission wording", () => {
  const base = { permission: "edit" as const, tools: ["Read"], provider: "claude" };
  it("a role with Bash but no Edit runs commands and cannot edit", () => {
    expect(permissionText({ ...base, canRun: true, canEdit: false, permissionSource: "tools", permissionReason: "tools:write", tools: ["Read", "Bash"] }).means).toBe("Runs commands (each asks first), cannot edit files.");
  });
  it("names the source: overlay, permissionMode, tools, all tools, ceiling, safe mode", () => {
    expect(permissionText({ ...base, permissionSource: "overlay" }).why).toBe("Because you set it here.");
    expect(permissionText({ ...base, permissionSource: "frontmatter", permissionReason: "permissionMode:plan", permission: "readOnly" }).why).toBe("Because its file says permissionMode: plan.");
    expect(permissionText({ ...base, permission: "readOnly", permissionSource: "tools", permissionReason: "tools:readOnly", tools: ["Read", "Grep", "Glob"] }).why).toBe("Because its tools are only Read, Grep, Glob (no Edit, Write or Bash).");
    expect(permissionText({ ...base, permissionSource: "allTools", permissionReason: "tools:all", tools: [] }).why).toBe("Because its file lists no tools, so it may use all of them.");
    const ceil = permissionText({ ...base, permission: "ask", permissionSource: "ceiling", permissionReason: "ceiling:repo" });
    expect(ceil.ceiling).toBe(true);
    expect(ceil.why).toMatch(/comes from a repository/);
    expect(permissionText({ ...base, permission: "readOnly", permissionSource: "overlayCorrupt" }).why).toMatch(/Safe mode/);
  });
  it("lists the roles that can edit because their own file says so", () => {
    const edit = { ...DEV, canEdit: true, permission: "edit" as const, permissionSource: "tools" as const };
    expect(derivedEditors([GROUP({ name: "a", role: { ...edit, name: "a" } }), GROUP({ name: "b", role: { ...edit, name: "b", permissionSource: "overlay" } }), GROUP({ name: "c", hidden: true, role: { ...edit, name: "c" } })])).toEqual(["a"]);
  });
});

describe("codes in words", () => {
  it("shows a delete refusal from its code and a generic text for an unknown one", () => {
    expect(deleteErrorText({ code: "noBackupDir", message: "x" })).toMatch(/no safe place for the backup/);
    expect(deleteErrorText({ code: "weird", message: "Boom" })).toBe("The role was not deleted");
    expect(deleteErrorText(new Error("x"))).toBe("The role was not deleted");
  });
  it("words exclusion reasons and warning codes, and passes an unknown one through", () => {
    expect(excludeReasonText("untrusted")).toMatch(/not trusted/);
    expect(excludeReasonText("novel")).toBe("novel");
    expect(warningText("reserved")).toMatch(/reserved/);
    expect(warningText("effortXhigh")).toMatch(/xhigh effort/);
    expect(warningText("effortMax")).toMatch(/max effort/);
    expect(warningText("novelCode")).toBe("novelCode");
  });
});
