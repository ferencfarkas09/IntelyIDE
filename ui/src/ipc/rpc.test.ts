import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { call, EPOCH_COMMANDS, setPageEpoch, withEpoch } from "./rpc";

afterEach(() => {
  setPageEpoch(undefined);
  invoke.mockClear();
});

describe("page epoch", () => {
  it("is added to exactly the commands of the spec and to no other", async () => {
    setPageEpoch(7);
    for (const c of EPOCH_COMMANDS) expect(withEpoch(c, { a: 1 })).toEqual({ a: 1, epoch: 7 });
    expect([...EPOCH_COMMANDS].sort()).toEqual(["commit_start", "fetch", "pull", "push_start", "set_push_target", "workspace_save", "workspaces_add_repos", "workspaces_relocate_repo"]);
    for (const c of ["workspace_get", "snapshot_get", "workspaces_switch", "workspaces_ready", "term_open", "agent_start"]) expect(withEpoch(c, { a: 1 })).toEqual({ a: 1 });
    await call("push_start", { req: 1 });
    expect(invoke).toHaveBeenCalledWith("push_start", { req: 1, epoch: 7 });
    await call("workspaces_ready", { epoch: 9 });
    expect(invoke).toHaveBeenLastCalledWith("workspaces_ready", { epoch: 9 });
  });

  it("is absent until the page sets it, and arguments of commands without args stay undefined", () => {
    expect(withEpoch("push_start", { req: 1 })).toEqual({ req: 1 });
    setPageEpoch(3);
    expect(withEpoch("workspace_get")).toBeUndefined();
    expect(withEpoch("fetch")).toEqual({ epoch: 3 });
  });
});
