import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => ({ list: [] as { location?: string; status: string; repoIds: string[] }[] }));
vi.mock("../../../store/agents", () => ({ agentRows: () => rows.list }));
vi.mock("../../../ipc", async (orig) => {
  const mod = await orig<typeof import("../../../ipc")>();
  const { createMockIpc } = await import("../../../ipc/mock");
  return { ...mod, ipc: createMockIpc("normal", { delayScale: 0 }) };
});

import { ipc } from "../../../ipc";
import { createMockServers } from "../../../ipc/mock/servers";
import { installDomStubs } from "../../../store/testing-u2";
import { loadWorkspace, repos } from "../../../store/workspace";
import { resetServers } from "../store";
import { ServerChangesPanel } from "./ServerChangesPanel";
import { canConfirm, transferMessage } from "./TransferDialog";
import { resetServerView, setViewOpen } from "./serverView";

installDomStubs();
vi.setConfig({ testTimeout: 30000 });

let repoId = "";
beforeEach(async () => {
  resetServers();
  resetServerView();
  (ipc as { servers: unknown }).servers = createMockServers({ stepMs: 0 });
  await loadWorkspace();
  repoId = repos()[0].id;
  // a repo name that the mock answers with changes
  rows.list = [{ location: "build-server", status: "running", repoIds: [repoId] }];
  setViewOpen(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the server view", () => {
  it("shows a Server group per repository of a server run, with a badge, the files and the read-only hint, and no write actions", async () => {
    // pick an id the mock answers with a list of files
    const spy = vi.spyOn(ipc.servers, "changes").mockResolvedValue({
      source: "server(Build server)", state: "ok", physical: "/home/me/work/app", head: "a".repeat(40), branch: "main", detached: false, ahead: 0, behind: 0, origin: null,
      changes: [{ path: "src/a.ts", kind: "modified", indexStatus: " ", worktreeStatus: "M", staged: false, partiallyStaged: false, guard: "ok" }], total: 1, truncated: false, updatedAtMs: Date.now(),
    } as never);
    render(() => <ServerChangesPanel />);
    const group = await screen.findByRole("region", { name: "Read-only view of the working copy on Build server" });
    expect(within(group).getByText("Server: Build server")).toBeTruthy();
    expect(within(group).getByRole("button", { name: "Show the changes in a.ts" })).toBeTruthy();
    expect(within(group).getByText("Commit on the server, or bring the changes here")).toBeTruthy();
    expect(within(group).getByText(/^Updated /)).toBeTruthy();
    // nothing to tick and nothing to commit, stage, discard or stash
    expect(within(group).queryAllByRole("checkbox")).toHaveLength(0);
    for (const name of [/commit/i, /stage/i, /discard/i, /stash/i, /rollback/i]) expect(within(group).queryAllByRole("button", { name })).toHaveLength(0);
    // a run works there: sending is off
    expect(within(group).getByRole("button", { name: "Send my changes there" }).getAttribute("aria-disabled")).toBe("true");
    expect(spy).toHaveBeenCalledWith("build-server", repoId);
  });

  it("says plainly when the server cannot be reached, the folder is missing or it is no git repository", async () => {
    vi.spyOn(ipc.servers, "changes").mockRejectedValue({ code: "ssh", message: "Host key verification failed." });
    render(() => <ServerChangesPanel />);
    expect(await screen.findByText("Cannot reach the server")).toBeTruthy();
    expect(screen.getByText("Host key verification failed.")).toBeTruthy();
    cleanup();
    resetServerView();
    for (const [state, text] of [["missing", "The folder does not exist on the server"], ["notGit", "The folder on the server is not a git repository"]] as const) {
      vi.spyOn(ipc.servers, "changes").mockResolvedValue({ source: "server(Build server)", state, detached: false, ahead: 0, behind: 0, changes: [], total: 0, truncated: false, updatedAtMs: Date.now() } as never);
      render(() => <ServerChangesPanel />);
      expect(await screen.findByText(text)).toBeTruthy();
      cleanup();
      resetServerView();
    }
  });

  it("changes nothing until the confirmation: the plan is read, the transfer runs only on the confirm button", async () => {
    const bring = vi.spyOn(ipc.servers, "transferBring");
    const send = vi.spyOn(ipc.servers, "transferSend");
    const plan = vi.spyOn(ipc.servers, "transferPlan");
    rows.list = [{ location: "build-server", status: "done", repoIds: [repoId] }];
    render(() => <ServerChangesPanel />);
    const group = await screen.findByRole("region", { name: "Read-only view of the working copy on Build server" });
    await waitFor(() => expect(within(group).getByRole("button", { name: "Bring changes here" })).toBeTruthy());
    fireEvent.click(within(group).getByRole("button", { name: "Bring changes here" }));
    const dlg = await screen.findByRole("alertdialog");
    await waitFor(() => expect(within(dlg).getByText("src/server.ts")).toBeTruthy());
    expect(within(dlg).getByText(/2 changed files, 1 new file/)).toBeTruthy();
    expect(plan).toHaveBeenCalledWith("build-server", repoId, "bring");
    expect(bring).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    // the diffstat is shown, the risky file is highlighted, and the button waits for the extra tick
    expect(within(dlg).getByText("+3 -1")).toBeTruthy();
    expect(within(dlg).getByText(".vscode/tasks.json")).toBeTruthy();
    expect(within(dlg).getByText(/secret inside an ordinarily named file cannot be detected/)).toBeTruthy();
    const confirmBtn = within(dlg).getAllByRole("button", { name: "Bring changes here" }).pop()!;
    expect(confirmBtn.getAttribute("aria-disabled") === "true" || (confirmBtn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirmBtn);
    expect(bring).not.toHaveBeenCalled();
    fireEvent.click(within(dlg).getByRole("checkbox", { name: /I have looked at the highlighted files/ }));
    fireEvent.click(within(dlg).getAllByRole("button", { name: "Bring changes here" }).pop()!);
    await waitFor(() => expect(bring).toHaveBeenCalledWith("build-server", repoId, false, "mock-plan", true));
    expect(send).not.toHaveBeenCalled();
  });
});

describe("the confirmation rules", () => {
  const base = { direction: "bring", files: [{ path: "a", kind: "modified", untracked: false }], tracked: 1, untracked: 0, sameOrigin: true, sameHead: true, destinationClean: true, blocked: [], risky: [], stat: [], bytes: 10, patchId: "id1", refusal: null } as never;
  it("is open only for a plan with files, no refusal, nothing blocked, and a clean destination or apply on top", () => {
    expect(canConfirm(undefined, false)).toBe(false);
    expect(canConfirm(base, false)).toBe(true);
    expect(canConfirm({ ...(base as object), destinationClean: false } as never, false)).toBe(false);
    expect(canConfirm({ ...(base as object), destinationClean: false } as never, true)).toBe(true);
    expect(canConfirm({ ...(base as object), refusal: { code: "headDiffers", message: "x" } } as never, true)).toBe(false);
    expect(canConfirm({ ...(base as object), blocked: [{ path: "p", code: "binary", reason: "r" }] } as never, true)).toBe(false);
    expect(canConfirm({ ...(base as object), files: [] } as never, true)).toBe(false);
    expect(canConfirm({ ...(base as object), patchId: "" } as never, true)).toBe(false);
    const risky = { ...(base as object), risky: [{ path: ".env.local", code: "env" }] } as never;
    expect(canConfirm(risky, false, false)).toBe(false);
    expect(canConfirm(risky, false, true)).toBe(true);
  });

  it("explains a different commit with the way out, and falls back to the backend text for an unknown code", () => {
    const m = transferMessage("headDiffers", "x", { localHead: "1234567890abcdef", serverHead: "fedcba0987654321" });
    expect(m).toContain("12345678");
    expect(m).toContain("fedcba09");
    expect(m).toContain("Pull or push");
    expect(transferMessage("somethingNew", "backend words")).toBe("backend words");
  });
});
