import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "intely.commit.draft";

// Each case re-imports the module graph (the draft is read at import), which is slow on a loaded machine.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

async function load() {
  vi.resetModules();
  const ws = await import("../../store/workspaces");
  const st = await import("./messageState");
  return { ws, st };
}

beforeEach(() => {
  localStorage.clear();
});

describe("per-workspace commit drafts", () => {
  it("migrates the old flat draft into w-migrated once and keeps working with it", async () => {
    localStorage.setItem(KEY, JSON.stringify({ shared: "wip: old", repos: { backend: "fix" } }));
    const { st } = await load();
    expect(st.sharedMessage()).toBe("wip: old");
    expect(st.repoMessage("backend")).toBe("fix");
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ "w-migrated": { shared: "wip: old", repos: { backend: "fix" } } });
  });

  it("typing stores the draft under the owning workspace only", async () => {
    const { st } = await load();
    st.setSharedMessage("hello");
    st.setRepoMessage("api", "api msg");
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ "w-migrated": { shared: "hello", repos: { api: "api msg" } } });
  });

  it("opening a workspace switches the visible draft to that workspace's", async () => {
    localStorage.setItem(KEY, JSON.stringify({ "w-migrated": { shared: "mine", repos: {} }, w3f9a1c2b4: { shared: "side", repos: { r: "x" } } }));
    const { createMockIpc } = await import("../../ipc/mock");
    vi.resetModules();
    const { createMockWorkspaces } = await import("../../ipc/mock/workspaces");
    const reg = createMockWorkspaces({ seed: [] });
    await reg.switch("w3f9a1c2b4", { force: true });
    const ipc = createMockIpc("normal", { delayScale: 0, workspaces: reg });
    const ws = await import("../../store/workspaces");
    const st = await import("./messageState");
    const stop = ws.startWorkspaces(ipc);
    await vi.waitFor(() => expect(st.sharedMessage()).toBe("side"));
    expect(st.repoMessage("r")).toBe("x");
    st.setSharedMessage("side 2");
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ "w-migrated": { shared: "mine" }, w3f9a1c2b4: { shared: "side 2" } });
    stop();
  });

  it("garbage in storage is an empty draft; a throwing storage does not break typing", async () => {
    localStorage.setItem(KEY, "{nope");
    const { st } = await load();
    expect(st.sharedMessage()).toBe("");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => st.setSharedMessage("still ok")).not.toThrow();
    expect(st.sharedMessage()).toBe("still ok");
  });
});
