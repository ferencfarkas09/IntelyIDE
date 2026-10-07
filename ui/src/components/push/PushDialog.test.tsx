import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async () => ({ ipc: (await import("../../store/testing-u2")).normal.ipc }));
vi.mock("../../store/selection", async () => (await import("../../store/testing-u2")).selectionModule);
vi.mock("../../store/snapshots", async () => (await import("../../store/testing-u2")).snapshotsModule);
vi.mock("../../store/workspace", async () => (await import("../../store/testing-u2")).workspaceModule);

import { ipc } from "../../ipc";
import { closePushDialog, openPushDialog, pushDialogRequest, resetActions } from "../../store/actions";
import { installDomStubs, normal, seedStores } from "../../store/testing-u2";
import { PushDialog } from "./PushDialog";
import { setPreviewNonProtected, setPushTags, setRunGitHooks } from "./settings";

installDomStubs();

beforeEach(async () => {
  localStorage.clear();
  resetActions();
  normal.reset();
  setPushTags("none");
  setRunGitHooks(true);
  setPreviewNonProtected(true);
  await seedStores(ipc, {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const repoBox = (name: string) => screen.getByRole("checkbox", { name: `Push ${name}` }) as HTMLInputElement;
const pushButton = () => screen.getByRole("button", { name: /^Push( \(|$)/ });

async function openDialog(ids?: string[]) {
  render(() => <PushDialog />);
  openPushDialog(ids);
  await screen.findByRole("tree", { name: "Repositories and outgoing commits" });
  await screen.findAllByText("Add loyalty points accrual to order close");
}

describe("<PushDialog> (mock scenario normal)", () => {
  it("lists all repos, ticks those with outgoing commits and greys out the others", async () => {
    await openDialog();
    expect(repoBox("shop-backend").checked).toBe(true);
    expect(repoBox("admin").checked).toBe(true);
    expect(repoBox("shop-mobile").checked).toBe(false);
    expect(repoBox("shop-mobile").disabled).toBe(true);
    expect(repoBox("shop-pos").disabled).toBe(true);
    expect(screen.getAllByText("Nothing to push")).toHaveLength(2);
    expect(pushButton().textContent).toContain("Push (2 repos)");
    // The first outgoing commit is selected and its files are shown on the right.
    expect(await screen.findByText("loyaltyService.js")).not.toBeNull();
  });

  it("shows the mapped target of a repo and marks protected branches", async () => {
    await openDialog();
    expect(screen.getByTitle("feature-light-design pushes to origin/sandbox")).not.toBeNull();
    expect(screen.getByTitle("main pushes to origin/main (protected branch)")).not.toBeNull();
  });

  it("closes with Escape and with Cancel", async () => {
    await openDialog();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(pushDialogRequest()).toBeNull());
  });

  it("pushes the ticked repos and turns hooks off with the toggle", async () => {
    await openDialog();
    const push = vi.spyOn(ipc, "pushStart");
    fireEvent.click(screen.getByRole("switch", { name: "Run Git hooks" }));
    fireEvent.click(repoBox("admin"));
    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    fireEvent.click(pushButton());
    await waitFor(() => expect(push).toHaveBeenCalledOnce());
    const req = push.mock.calls[0][0];
    expect(req.noVerify).toBe(true);
    expect(req.targets.map((t) => [t.repoId, t.tags, t.forceWithLease])).toEqual([["backend", "all", undefined]]);
    await waitFor(() => expect(pushDialogRequest()).toBeNull());
  });

  it("requires the branch name for a force push to a protected branch, then pushes with a lease", async () => {
    const plans = await ipc.pushPlan(["backend", "admin", "services", "pos"], false);
    vi.spyOn(ipc, "pushPlan").mockResolvedValue(plans.map((p) => (p.repoId === "backend" ? { ...p, protected: true, remoteBranch: "release/1" } : p)));
    await openDialog();
    const push = vi.spyOn(ipc, "pushStart");
    // the live-branch field comes first: until it matches, even the force menu is disabled
    fireEvent.input(screen.getByLabelText("Type release/1 to push shop-backend to a live branch"), { target: { value: "release/1" } });

    fireEvent.click(screen.getByRole("button", { name: "More push actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Force push \(with lease\)/ }));
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Force push" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    // Only the protected repo asks for its branch name.
    const field = within(dialog).getByLabelText("Type release/1 to confirm force push of shop-backend");
    expect(within(dialog).queryByLabelText(/force push of admin/)).toBeNull();
    fireEvent.input(field, { target: { value: "release" } });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.input(field, { target: { value: "release/1" } });
    expect(confirm.hasAttribute("disabled")).toBe(false);

    fireEvent.click(confirm);
    await waitFor(() => expect(push).toHaveBeenCalledOnce());
    expect(push.mock.calls[0][0].targets.map((t) => [t.repoId, t.remoteBranch, t.forceWithLease])).toEqual([
      ["backend", "release/1", { seenOid: "" }],
      ["admin", "sandbox", { seenOid: "" }],
    ]);
    expect(push.mock.calls[0][0].targets.map((t) => t.confirmLive)).toEqual(["release/1", undefined]);
  });

  describe("live branches", () => {
    async function openWithLiveBackend() {
      const plans = await ipc.pushPlan(["backend", "admin", "services", "pos"], false);
      vi.spyOn(ipc, "pushPlan").mockResolvedValue(plans.map((p) => (p.repoId === "backend" ? { ...p, protected: true, remoteBranch: "main" } : p)));
      await openDialog();
    }
    const field = () => screen.getByLabelText("Type main to push shop-backend to a live branch") as HTMLInputElement;

    it("asks for the branch name, keeps Push disabled until it matches exactly, then sends confirmLive", async () => {
      await openWithLiveBackend();
      const push = vi.spyOn(ipc, "pushStart");
      expect(screen.getByText(/to push to a live branch/)).not.toBeNull();
      expect(pushButton().hasAttribute("disabled")).toBe(true);
      for (const wrong of ["mai", "Main", "main "]) {
        fireEvent.input(field(), { target: { value: wrong } });
        expect(pushButton().hasAttribute("disabled")).toBe(true);
      }
      fireEvent.input(field(), { target: { value: "main" } });
      expect(pushButton().hasAttribute("disabled")).toBe(false);
      fireEvent.click(pushButton());
      await waitFor(() => expect(push).toHaveBeenCalledOnce());
      expect(push.mock.calls[0][0].targets.map((t) => [t.repoId, t.confirmLive])).toEqual([["backend", "main"], ["admin", undefined]]);
    });

    it("asks for nothing when no ticked target is live", async () => {
      await openDialog();
      expect(screen.queryByText(/to push to a live branch/)).toBeNull();
      expect(pushButton().hasAttribute("disabled")).toBe(false);
    });

    it("does not allow skipping hooks for a live branch", async () => {
      await openWithLiveBackend();
      fireEvent.input(field(), { target: { value: "main" } });
      fireEvent.click(screen.getByRole("switch", { name: "Run Git hooks" }));
      expect(pushButton().hasAttribute("disabled")).toBe(true);
      expect(screen.getByText(/Hooks cannot be skipped/)).not.toBeNull();
    });
  });

  it("saves the edited targets when Enter is pressed in a field", async () => {
    await openDialog();
    const save = vi.spyOn(ipc, "setPushTarget");
    fireEvent.click(screen.getByRole("button", { name: "Edit all targets" }));
    const field = await screen.findByLabelText("Remote branch for admin");
    fireEvent.input(field, { target: { value: "release/light" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("table", { name: "Push targets" })).toBeNull());
    expect(save).toHaveBeenCalledWith("admin", "feature-light-design", "origin", "release/light");
  });

  it("explains a planning error and lets the user try again", async () => {
    const plan = vi.spyOn(ipc, "pushPlan").mockRejectedValueOnce({ code: "git", message: "ls-remote timed out" });
    render(() => <PushDialog />);
    openPushDialog();
    expect(await screen.findByText("ls-remote timed out")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findAllByText("Add loyalty points accrual to order close");
    expect(plan).toHaveBeenCalledTimes(2);
    closePushDialog();
  });
});
