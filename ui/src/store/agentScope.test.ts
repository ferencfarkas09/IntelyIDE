import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc", () => ({ ipc: {} }));

import { ipc } from "../ipc";
import { createMockIpc } from "../ipc/mock";
import { enterEmptyState, workspaceState } from "./workspace";
import { foreignReason, hiddenCount, isForeign, knownOnly, ownerOf, resolvesIn, scopeRows, setShowOtherWorkspaces } from "./agentScope";
import { readScoped, scopedKey, writeScoped } from "./scopedStorage";
import { resetWorkspacesForTest, startWorkspaces, workspaces } from "./workspaces";
import { waitFor } from "@solidjs/testing-library";

const run = (id: string, repoIds: string[]) => ({ id, repoIds });

describe("resolvesIn", () => {
  it("every repo id must be known; no repositories belongs everywhere", () => {
    expect(resolvesIn(["a", "b"], ["a", "b", "c"])).toBe(true);
    expect(resolvesIn(["a", "z"], ["a", "b"])).toBe(false);
    expect(resolvesIn([], [])).toBe(true);
  });
});

describe("with two mock workspaces", () => {
  beforeEach(async () => {
    resetWorkspacesForTest();
    enterEmptyState();
    setShowOtherWorkspaces(false);
    localStorage.clear();
    Object.assign(ipc, createMockIpc("normal", { delayScale: 0 }));
    startWorkspaces(ipc as never);
    await waitFor(() => expect(workspaceState()).toBe("ready"));
    await waitFor(() => expect(workspaces().length).toBe(3));
  });

  const rows = [run("mine", ["backend", "admin"]), run("mixed", ["backend", "shop-api"]), run("other", ["crm-9f8e7d6c5b"]), run("none", [])];

  it("a run belongs to the open workspace only when every repo id resolves in it", async () => {
    await waitFor(() => expect(isForeign(["backend"])).toBe(false));
    expect(isForeign(["backend", "admin"])).toBe(false);
    expect(isForeign(["backend", "crm-9f8e7d6c5b"])).toBe(true);
    expect(isForeign([])).toBe(false);
  });

  it("foreign runs are hidden by default, shown (read-only) behind the toggle, and counted", () => {
    expect(scopeRows(rows).map((r) => r.id)).toEqual(["mine", "none"]);
    expect(hiddenCount(rows)).toBe(2);
    setShowOtherWorkspaces(true);
    expect(scopeRows(rows)).toHaveLength(4);
    expect(hiddenCount(rows)).toBe(0);
  });

  it("names the workspace to open to continue a run, or says it belongs elsewhere", () => {
    expect(ownerOf(["crm-9f8e7d6c5b"])?.name).toBe("Client X");
    expect(foreignReason(["crm-9f8e7d6c5b"])).toBe('Open workspace "Client X" to continue');
    expect(ownerOf(["backend", "crm-9f8e7d6c5b"])).toBeUndefined();
    expect(foreignReason(["backend", "crm-9f8e7d6c5b"])).toBe("This run belongs to another workspace.");
    expect(ownerOf(["backend"])).toBeUndefined();
  });

  it("role default repositories keep only the ids of the open workspace", () => {
    expect(knownOnly(["admin", "crm-9f8e7d6c5b", "backend"])).toEqual(["admin", "backend"]);
    expect(knownOnly(undefined)).toEqual([]);
  });
});

describe("scoped storage keys", () => {
  beforeEach(() => localStorage.clear());
  it("are per workspace; the old unscoped value belongs to the migrated workspace only", () => {
    localStorage.setItem("intely.x", "legacy");
    expect(readScoped("intely.x", "w-migrated")).toBe("legacy");
    expect(readScoped("intely.x", "w2")).toBeNull();
    writeScoped("intely.x", "mine", "w2");
    expect(localStorage.getItem(scopedKey("intely.x", "w2"))).toBe("mine");
    expect(readScoped("intely.x", "w2")).toBe("mine");
    expect(readScoped("intely.x", "w-migrated")).toBe("legacy");
    writeScoped("intely.x", "new", "w-migrated");
    expect(readScoped("intely.x", "w-migrated")).toBe("new");
    expect(localStorage.getItem("intely.x")).toBe("legacy");
  });
});
