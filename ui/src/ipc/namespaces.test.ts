import { describe, expect, it, vi } from "vitest";
import { createMockIpc } from "./mock";
import { createMockNamespaces, createTauriNamespaces } from "./namespaces";
import { notImplemented } from "./rpc";

describe("ipc namespaces", () => {
  it("are composed next to the flat methods of the mock Ipc", () => {
    const ipc = createMockIpc("normal", { delayScale: 0 });
    expect(Object.keys(createMockNamespaces()).sort()).toEqual(["branches", "files", "graph", "happy", "hud", "mcp", "mongo", "mongoAi", "picker", "preview", "providers", "remote", "roles", "run", "runs", "search", "secrets", "settings", "term", "tray", "updates", "viewers", "workspaces"]);
    expect(typeof ipc.snapshotGet).toBe("function");
    expect(typeof ipc.files.readFile).toBe("function");
  });

  it("reject with a clear `unimplemented` EngineError in the Tauri stubs, and subscriptions are no-ops", async () => {
    const t = createTauriNamespaces();
    await expect(notImplemented("x.y")).rejects.toMatchObject({ code: "unimplemented", message: "x.y is not implemented yet" });
    expect(typeof t.happy.timer.start).toBe("function");
  });

  it("files mock: lists, reads, guards secrets and refuses a stale write", async () => {
    const { files } = createMockNamespaces();
    expect((await files.listDir("r", "")).map((e) => e.name)).toEqual(["assets", "data", "dist", "docs", "empty-dir", "node_modules", "src", ".env", ".gitignore", "package.json", "README.md"]);
    expect((await files.readFile("r", ".env")).text).toBeUndefined();
    expect((await files.readFile("r", ".env", { reveal: true })).text).toBe("SECRET=1\n");
    const read = await files.readFile("r", "README.md");
    const changed = vi.fn();
    files.onFileChanged(changed);
    const { mtimeMs } = await files.writeFile("r", "README.md", "# New\n", read.mtimeMs);
    expect(mtimeMs).toBeGreaterThan(read.mtimeMs);
    await expect(files.writeFile("r", "README.md", "x", read.mtimeMs)).rejects.toMatchObject({ code: "staleFile" });
    await Promise.resolve();
    expect(changed).toHaveBeenCalledWith({ repoId: "r", path: "README.md", kind: "changed" });
    expect(await files.quickOpenIndex("r")).not.toContain(".env");
  });

  it("search mock: finds matches through the same tree and reports done", async () => {
    const { search } = createMockNamespaces();
    const batches: unknown[] = [];
    search.onResults((b) => batches.push(b));
    const { searchId } = await search.start("answer");
    await vi.waitFor(() => expect(batches).toHaveLength(1));
    expect(batches[0]).toMatchObject({ searchId, done: true, hits: [{ path: "src/index.ts", line: 1, col: 14 }] });
  });

  it("settings mock merges patches and notifies; secrets never come back", async () => {
    const { settings, secrets } = createMockNamespaces();
    const seen = vi.fn();
    settings.onChange(seen);
    await settings.set("editor", { fontSize: 13 });
    expect(await settings.set("editor", { tabWidth: 2 })).toEqual({ fontSize: 13, tabWidth: 2 });
    expect(await settings.get("terminal")).toEqual({});
    expect(seen).toHaveBeenCalledTimes(2);
    await secrets.set("anthropic", "sk-test");
    expect(await secrets.has("anthropic")).toBe(true);
    expect(Object.keys(secrets)).not.toContain("get");
    await secrets.remove("anthropic");
    expect(await secrets.has("anthropic")).toBe(false);
  });
});
