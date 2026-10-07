import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: [string, unknown][] = [];
vi.mock("./rpc", () => ({
  call: async (cmd: string, args?: unknown) => {
    calls.push([cmd, args]);
    return undefined;
  },
}));

import { createTauriMcp, type McpIpc } from "./mcp";
import { createMockMcp } from "./mock/mcp";
import { createMockSettings } from "./mock/settings";

beforeEach(() => {
  calls.length = 0;
});

describe("the Tauri MCP namespace", () => {
  it("invokes the exact command names of the spec with camelCase arguments", async () => {
    const mcp = createTauriMcp();
    await mcp.list("w-1");
    await mcp.list();
    await mcp.list(null);
    await mcp.save({ name: "github", transport: "stdio", command: "npx", args: ["-y"], env: [{ name: "GITHUB_TOKEN", secret: true, secretValue: "x" }], enabled: true });
    await mcp.remove("m1");
    await mcp.setEnabled("m1", true);
    await mcp.confirm("m1", "abc");
    await mcp.workspaceSet("w-1", "m1", "off");
    await mcp.setPolicy("m1", { defaultPolicy: "deny", tools: [{ tool: "t", policy: null, acknowledgeBlocked: true }] });
    await mcp.test("m1");
    await mcp.test("m1", 30000);
    await mcp.importPreview("tok");
    await mcp.importApply("imp", [{ key: "a", name: "a", replace: false }]);
    await mcp.secretsPresent();
    await mcp.secretsPresent(["m1"]);
    await mcp.runServers("w-1", "claude");
    await mcp.runServers(null, "mock");
    expect(calls).toEqual([
      ["mcp_list", { workspaceId: "w-1" }],
      ["mcp_list", {}],
      ["mcp_list", {}],
      ["mcp_save", { input: { name: "github", transport: "stdio", command: "npx", args: ["-y"], env: [{ name: "GITHUB_TOKEN", secret: true, secretValue: "x" }], enabled: true } }],
      ["mcp_remove", { id: "m1" }],
      ["mcp_set_enabled", { id: "m1", enabled: true }],
      ["mcp_confirm", { id: "m1", confirmHash: "abc" }],
      ["mcp_workspace_set", { workspaceId: "w-1", serverId: "m1", state: "off" }],
      ["mcp_set_policy", { id: "m1", patch: { defaultPolicy: "deny", tools: [{ tool: "t", policy: null, acknowledgeBlocked: true }] } }],
      ["mcp_test", { id: "m1" }],
      ["mcp_test", { id: "m1", timeoutMs: 30000 }],
      ["mcp_import_preview", { token: "tok" }],
      ["mcp_import_apply", { importId: "imp", picks: [{ key: "a", name: "a", replace: false }] }],
      ["mcp_secrets_present", {}],
      ["mcp_secrets_present", { ids: ["m1"] }],
      ["mcp_run_servers", { workspaceId: "w-1", provider: "claude" }],
      ["mcp_run_servers", { provider: "mock" }],
    ]);
  });
});

/** The mock must answer the same interface, with the behaviours the screens rely on. */
describe("the MCP mock", () => {
  const make = (opts = {}) => {
    const settings = createMockSettings();
    const changes: string[] = [];
    settings.onChange((e) => changes.push(e.ns));
    return { mcp: createMockMcp(settings, { delayMs: 0, ...opts }) satisfies McpIpc, changes };
  };

  it("is seeded with a tested, an untested and a secret-missing server and never carries a secret", async () => {
    const { mcp } = make();
    const list = await mcp.list("w-1");
    expect(list.servers.map((s) => [s.name, s.state, s.toolsTestedAt !== null])).toEqual([["fixture", "ready", true], ["docs", "needsConfirm", false], ["github", "secretMissing", false]]);
    expect(list.workspace).toEqual({ id: "w-1", overrides: [] });
    expect(JSON.stringify(list)).not.toMatch(/secretValue|CANARY/);
    expect(list.servers[2].env).toEqual([{ name: "GITHUB_TOKEN", secret: true, present: false }]);
    expect(list.servers[2].fetchesCode).toBe(true);
    const tool = list.servers[0].tools.find((t) => t.key === "git_commit")!;
    expect(tool).toMatchObject({ blockedByDefault: true, seeded: true, policy: "deny" });
  });

  it("keeps a typed secret out of every view and only remembers that the slot has a value", async () => {
    const { mcp } = make({ empty: true });
    const saved = await mcp.save({ name: "canary", transport: "stdio", command: "node", args: ["/a/b.js"], env: [{ name: "API_TOKEN", secret: true, secretValue: "CANARY-MCP-7f3a" }], enabled: false });
    expect(saved.env).toEqual([{ name: "API_TOKEN", secret: true, present: true }]);
    expect(JSON.stringify(await mcp.list())).not.toContain("CANARY-MCP-7f3a");
    expect(await mcp.secretsPresent()).toEqual([{ serverId: saved.id, slot: "env:API_TOKEN", present: true }]);
    // an edit that leaves the slot alone keeps it
    const edited = await mcp.save({ id: saved.id, name: "canary", transport: "stdio", command: "node", args: ["/a/b.js"], env: [{ name: "API_TOKEN", secret: true }], enabled: false });
    expect(edited.env[0].present).toBe(true);
  });

  it("answers the validation errors of the spec with their stable codes", async () => {
    const { mcp } = make();
    const base = { name: "x1", transport: "stdio" as const, command: "node", enabled: true };
    await expect(mcp.save({ ...base, name: "Bad Name" })).rejects.toMatchObject({ code: "mcpBadName" });
    await expect(mcp.save({ ...base, name: "docs" })).rejects.toMatchObject({ code: "mcpNameTaken" });
    await expect(mcp.save({ ...base, command: "./x" })).rejects.toMatchObject({ code: "mcpRelativePath" });
    await expect(mcp.save({ ...base, args: ["sk-abc"] })).rejects.toMatchObject({ code: "mcpSecretInArgs" });
    await expect(mcp.save({ ...base, env: [{ name: "NODE_OPTIONS", secret: false, value: "x" }] })).rejects.toMatchObject({ code: "mcpExecVar" });
    await expect(mcp.save({ ...base, env: [{ name: "API_KEY", secret: false, value: "x" }] })).rejects.toMatchObject({ code: "mcpPlainSecretName" });
    await expect(mcp.save({ name: "web", transport: "http", url: "http://example.com", enabled: true })).rejects.toMatchObject({ code: "mcpBadUrl" });
  });

  it("gates Test and the switch on the confirmation, and a stale hash cannot confirm", async () => {
    const { mcp } = make();
    const docs = (await mcp.list()).servers[1];
    await expect(mcp.test(docs.id)).rejects.toMatchObject({ code: "confirmationRequired" });
    await expect(mcp.setEnabled(docs.id, true)).rejects.toMatchObject({ code: "confirmationRequired" });
    await expect(mcp.confirm(docs.id, "not-the-hash")).rejects.toMatchObject({ code: "confirmationRequired" });
    expect((await mcp.confirm(docs.id, docs.confirmHash)).confirmed).toBe(true);
    expect((await mcp.setEnabled(docs.id, true)).enabled).toBe(true);
    const report = await mcp.test(docs.id);
    expect(report).toMatchObject({ ok: true, toolCount: 4, blockedByDefault: ["git_commit"] });
    expect(report.tools.map((t) => [t.key, t.readOnlyHint])).toEqual([["echo", true], ["write_note", false], ["mystery", null], ["git_commit", false]]);
  });

  it("fails a Test the way a broken program, a slow one and an OAuth server do", async () => {
    const { mcp } = make({ empty: true });
    const confirmed = async (command: string, url?: string) => {
      const s = await mcp.save(url ? { name: "srv", transport: "http", url, enabled: true } : { name: "srv", transport: "stdio", command, args: [], enabled: true });
      return mcp.confirm(s.id, s.confirmHash);
    };
    const bad = await confirmed("/opt/fail-server");
    expect(await mcp.test(bad.id)).toMatchObject({ ok: false, error: { code: "mcpExited" } });
    await mcp.remove(bad.id);
    const slow = await confirmed("/opt/slow-server");
    expect(await mcp.test(slow.id)).toMatchObject({ ok: false, error: { code: "mcpTimeout" } });
    expect(await mcp.test(slow.id, 30000)).toMatchObject({ ok: true });
    await mcp.remove(slow.id);
    const oauth = await confirmed("", "https://oauth.example.com/mcp");
    expect(await mcp.test(oauth.id)).toMatchObject({ ok: false, error: { code: "mcpAuth", detail: "oauth" } });
  });

  it("refuses to loosen a seeded tool without the acknowledgement, and notifies the settings listeners", async () => {
    const { mcp, changes } = make();
    const fixture = (await mcp.list()).servers[0];
    await expect(mcp.setPolicy(fixture.id, { tools: [{ tool: "git_commit", policy: "allow" }] })).rejects.toMatchObject({ code: "mcpBlockedByDefault" });
    const view = await mcp.setPolicy(fixture.id, { tools: [{ tool: "git_commit", policy: "allow", acknowledgeBlocked: true }] });
    expect(view.tools.find((t) => t.key === "git_commit")).toMatchObject({ policy: "allow", seeded: false, effectivePolicy: "allow" });
    expect(changes).toContain("mcp");
  });

  it("answers the picker per workspace: defaults, overrides and why a server cannot start", async () => {
    const { mcp } = make();
    const [fixture, docs, github] = (await mcp.list()).servers;
    const first = await mcp.runServers("w-1", "claude");
    expect(first.map((s) => [s.name, s.defaultOn, s.available, s.unavailable])).toEqual([["fixture", true, true, undefined], ["docs", false, false, "needsConfirm"], ["github", false, false, "secretMissing"]]);
    expect(first[0]).toMatchObject({ toolCount: 4, readOnlyCount: 1, hasDenied: true, hasSecretEnv: false, exposedCount: 2 });
    expect(first[2].hasSecretEnv).toBe(true);
    await mcp.workspaceSet("w-1", fixture.id, "off");
    expect((await mcp.runServers("w-1", "claude"))[0].defaultOn).toBe(false);
    expect((await mcp.runServers("w-2", "claude"))[0].defaultOn).toBe(true);
    expect((await mcp.runServers("w-1", "codex")).every((s) => s.unavailable === "unsupportedProvider")).toBe(true);
    expect(docs.id).not.toBe(github.id);
  });

  it("previews names only and applies a pick as disabled, unconfirmed servers; a second apply expires", async () => {
    const { mcp } = make();
    const preview = await mcp.importPreview("tok");
    expect(JSON.stringify(preview)).not.toMatch(/ghp_|secretValue|value/);
    expect(preview.entries.map((e) => [e.key, e.importable])).toEqual([["github", true], ["filesystem", true], ["Sentry Prod", true], ["legacy-sse", false], ["local-script", false], ["analytics", false]]);
    expect(preview.entries[0]).toMatchObject({ conflict: true, issues: ["nameTaken"] });
    const result = await mcp.importApply(preview.importId, [{ key: "filesystem", name: "filesystem", replace: false }, { key: "github", name: "github", replace: false }, { key: "legacy-sse", name: "legacy-sse", replace: false }]);
    expect(result.imported.map((i) => i.key)).toEqual(["filesystem"]);
    expect(result.skipped).toEqual([{ key: "github", reason: "nameTaken" }, { key: "legacy-sse", reason: "notImportable" }]);
    const added = (await mcp.list()).servers.find((s) => s.name === "filesystem")!;
    expect(added).toMatchObject({ enabled: false, confirmed: false, imported: true, state: "needsConfirm" });
    await expect(mcp.importApply(preview.importId, [])).rejects.toMatchObject({ code: "mcpImportExpired" });
  });

  it("starts empty on request and refuses Test and import in the read-only jail", async () => {
    expect((await make({ empty: true }).mcp.list()).servers).toEqual([]);
    const { mcp } = make({ jail: "readOnly" });
    const fixture = (await mcp.list()).servers[0];
    await expect(mcp.test(fixture.id)).rejects.toMatchObject({ code: "readOnly" });
    await expect(mcp.importPreview("tok")).rejects.toMatchObject({ code: "readOnly" });
    expect((await mcp.runServers(null, "claude")).every((s) => !s.available)).toBe(true);
  });
});
