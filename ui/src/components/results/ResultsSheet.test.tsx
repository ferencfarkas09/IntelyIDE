import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async () => ({ ipc: (await import("../../store/testing-u2")).failures.ipc }));
vi.mock("../../store/selection", async () => (await import("../../store/testing-u2")).selectionModule);
vi.mock("../../store/snapshots", async () => (await import("../../store/testing-u2")).snapshotsModule);
vi.mock("../../store/workspace", async () => (await import("../../store/testing-u2")).workspaceModule);

import { ipc } from "../../ipc";
import { closePushDialog, commitAll, commitAndPush, pushDialogRequest, resetActions } from "../../store/actions";
import { failures, installDomStubs, seedStores } from "../../store/testing-u2";
import { resetMessageState, setSharedMessage } from "../commit/messageState";
import { ResultsSheet } from "./ResultsSheet";

installDomStubs();

beforeEach(async () => {
  localStorage.clear();
  resetActions();
  resetMessageState();
  failures.reset();
  await seedStores(ipc, { backend: ["src/api/routes/index.js"], services: ["locales/hu.json"] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NAMES: Record<string, string> = { backend: "shop-backend", services: "shop-mobile" };
const row = (repoId: string) => screen.getByRole("listitem", { name: new RegExp(`^${NAMES[repoId]}:`) });

describe("<ResultsSheet> (mock scenario failures)", () => {
  it("lists the failures with their recovery actions and the hook output", async () => {
    render(() => <ResultsSheet />);
    setSharedMessage("feat: routes");
    await commitAll();

    const backend = within(row("backend"));
    expect(backend.getByText("Pre-commit hook failed")).not.toBeNull();
    expect(backend.getByRole("button", { name: "Retry" })).not.toBeNull();
    expect(backend.getByRole("button", { name: "Retry without hooks" })).not.toBeNull();
    // A rejected hook is explained by its output, so it starts expanded.
    expect(backend.getByText(/lint-staged: checking staged files/)).not.toBeNull();
    expect(backend.getByRole("button", { name: "Hide output" }).getAttribute("aria-expanded")).toBe("true");

    const services = within(row("services"));
    expect(services.getByText("Another git process is running")).not.toBeNull();
    expect(services.queryByRole("button", { name: "Retry without hooks" })).toBeNull();
    expect(screen.getByText("Commit finished: 0 done, 2 failed")).not.toBeNull();
  });

  it("asks before retrying without hooks and then commits with --no-verify", async () => {
    render(() => <ResultsSheet />);
    setSharedMessage("feat: routes");
    await commitAll();
    const start = vi.spyOn(ipc, "commitStart");

    fireEvent.click(within(row("backend")).getByRole("button", { name: "Retry without hooks" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Retry without Git hooks?")).not.toBeNull();
    expect(start).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Commit without hooks" }));
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(start.mock.calls[0][0].noVerify).toBe(true);
    await waitFor(() => expect(within(row("backend")).getByText("Committed")).not.toBeNull());
  });

  it("cancelling the confirmation runs nothing", async () => {
    render(() => <ResultsSheet />);
    setSharedMessage("feat: routes");
    await commitAll();
    const start = vi.spyOn(ipc, "commitStart");
    fireEvent.click(within(row("backend")).getByRole("button", { name: "Retry without hooks" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(start).not.toHaveBeenCalled();
  });

  it("retries a lockBusy commit", async () => {
    render(() => <ResultsSheet />);
    setSharedMessage("fix: x");
    await commitAll();
    fireEvent.click(within(row("services")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(within(row("services")).getByText("Committed")).not.toBeNull());
  });

  it("warns about files a hook changed and offers a refresh when the index was not reconciled", async () => {
    vi.spyOn(ipc, "commitStart").mockImplementation(async (req) => {
      queueMicrotask(() =>
        failures.emitResult({
          runId: req.runId,
          kind: "commit",
          finishedAtMs: 1,
          repos: [{ repoId: "services", status: "done", commitOid: "abcdef1234567890", reconciled: false, hookModifiedFiles: ["a.js", "b.js", "c.js", "d.js"] }],
        }),
      );
      return { runId: req.runId };
    });
    const refresh = vi.spyOn(ipc, "snapshotRefresh");
    await seedStores(ipc, { services: ["locales/hu.json"] });
    render(() => <ResultsSheet />);
    setSharedMessage("fix: y");
    await commitAll();

    const services = within(row("services"));
    expect(services.getByText("Hooks changed 4 files")).not.toBeNull();
    expect(services.getByText("a.js, b.js, c.js +1 more")).not.toBeNull();
    expect(services.getByText("Committed, but the index was not refreshed.")).not.toBeNull();
    fireEvent.click(services.getByRole("button", { name: "Refresh" }));
    expect(refresh).toHaveBeenCalledWith("services");
  });

  it("marks a commit-and-push whose push did not happen as committed locally", async () => {
    await seedStores(ipc, { services: ["locales/hu.json"] });
    render(() => <ResultsSheet />);
    setSharedMessage("fix: z");
    // lockBusy once, then the retry commits; services is on main, so the push dialog opens (it is not rendered here).
    await commitAndPush();
    fireEvent.click(within(row("services")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(pushDialogRequest()).not.toBeNull());
    expect(within(row("services")).queryByText("Committed locally, not pushed")).toBeNull();
    // Dismissing the dialog without pushing leaves the commit local, and the sheet says so.
    closePushDialog();
    expect(await within(row("services")).findByText("Committed locally, not pushed")).not.toBeNull();
  });
});
