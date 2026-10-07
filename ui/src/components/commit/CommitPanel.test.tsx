import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async () => ({ ipc: (await import("../../store/testing-u2")).normal.ipc }));
vi.mock("../../store/selection", async () => (await import("../../store/testing-u2")).selectionModule);
vi.mock("../../store/snapshots", async () => (await import("../../store/testing-u2")).snapshotsModule);
vi.mock("../../store/workspace", async () => (await import("../../store/testing-u2")).workspaceModule);

import { ipc } from "../../ipc";
import { resetActions, sheetRows } from "../../store/actions";
import { installDomStubs, normal, seedStores } from "../../store/testing-u2";
import { CommitPanel } from "./CommitPanel";
import { messageHistory, resetMessageState } from "./messageState";

installDomStubs();

beforeEach(async () => {
  localStorage.clear();
  resetActions();
  resetMessageState();
  normal.reset();
  await seedStores(ipc, { services: ["locales/hu.json", "locales/en.json"], backend: ["src/api/routes/index.js"] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const messageBox = () => screen.getByLabelText("Commit message") as HTMLTextAreaElement;
const commitButton = () => screen.getByRole("button", { name: /^Commit \(/ });

describe("<CommitPanel>", () => {
  it("shows the target of the commit in the button and a non-blocking Conventional Commits hint", async () => {
    render(() => <CommitPanel />);
    expect(commitButton().textContent).toContain("Commit (2 repos, 3 files)");
    expect(screen.queryByText(/Conventional Commits/)).toBeNull();
    fireEvent.input(messageBox(), { target: { value: "Update stuff" } });
    expect(await screen.findByText(/Conventional Commits/)).not.toBeNull();
    fireEvent.input(messageBox(), { target: { value: "fix(ui): update stuff" } });
    expect(screen.queryByText(/Conventional Commits/)).toBeNull();
  });

  it("refuses an empty message with an inline error and starts nothing", async () => {
    const start = vi.spyOn(ipc, "commitStart");
    render(() => <CommitPanel />);
    fireEvent.click(commitButton());
    expect((await screen.findByRole("alert")).textContent).toBe("Enter a commit message.");
    expect(messageBox().getAttribute("aria-invalid")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(messageBox()));
    expect(start).not.toHaveBeenCalled();
    fireEvent.input(messageBox(), { target: { value: "chore: x" } });
    expect(screen.queryByText("Enter a commit message.")).toBeNull();
  });

  it("disables Amend while files of several repos are ticked", async () => {
    render(() => <CommitPanel />);
    const box = screen.getByRole("checkbox", { name: "Amend" }) as HTMLInputElement;
    expect(box.disabled).toBe(true);
  });

  it("commits with the shared message, clears the draft and remembers it in the history", async () => {
    const start = vi.spyOn(ipc, "commitStart");
    render(() => <CommitPanel />);
    fireEvent.input(messageBox(), { target: { value: "feat: booking labels" } });
    fireEvent.click(commitButton());
    await waitFor(() => expect(messageBox().value).toBe(""));
    expect(start.mock.calls[0][0].repos.map((r) => [r.repoId, r.message])).toEqual([
      ["backend", "feat: booking labels"],
      ["services", "feat: booking labels"],
    ]);
    expect(sheetRows()).toHaveLength(2);
    expect(messageHistory()).toEqual(["feat: booking labels"]);
  });

  it("commits with ⌘↵", async () => {
    const start = vi.spyOn(ipc, "commitStart");
    render(() => <CommitPanel />);
    fireEvent.input(messageBox(), { target: { value: "fix: shortcut" } });
    fireEvent.keyDown(document, { key: "Enter", metaKey: true });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
  });

  it("disables the button when nothing is ticked", async () => {
    await seedStores(ipc, {});
    render(() => <CommitPanel />);
    expect(screen.getByRole("button", { name: "Commit" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Tick files in the Changes list to commit them.")).not.toBeNull();
  });

  it("switches to per-repo messages and lists the repos that still need one", async () => {
    render(() => <CommitPanel />);
    fireEvent.click(screen.getByRole("radio", { name: "Per repo" }));
    expect(await screen.findByText("0 of 2 messages entered")).not.toBeNull();
    expect(screen.queryByLabelText("Commit message")).toBeNull();
    expect(screen.getAllByText("Needs a message")).toHaveLength(2);
  });

  it("drafts a message from the ticked files and shows the validator chip", async () => {
    const draft = vi.spyOn(ipc.graph, "draftMessageDetailed").mockResolvedValue({ message: "feat(orders): drafted", source: "model", issues: [] });
    vi.spyOn(ipc.graph, "validateMessage").mockResolvedValue({ ok: true, header: { type: "feat", scope: "orders", breaking: false, description: "drafted" }, issues: [] });
    render(() => <CommitPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Generate message" }));
    await waitFor(() => expect(messageBox().value).toBe("feat(orders): drafted"), { timeout: 5000 });
    expect(draft).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Conventional", {}, { timeout: 5000 })).not.toBeNull();
  });

  it("inserts the Extended English sections into an empty message and keeps typed text", async () => {
    render(() => <CommitPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Insert Extended English template" }));
    await waitFor(() => expect(messageBox().value).toContain("Extended English:"), { timeout: 5000 });
    fireEvent.input(messageBox(), { target: { value: "fix: keep me" } });
    fireEvent.click(screen.getByRole("button", { name: "Insert Extended English template" }));
    await waitFor(() => expect(messageBox().value).toMatch(/^fix: keep me\n\nExtended English:/), { timeout: 5000 });
  });

  it("returns the focus to the message field after a message is picked from the history", async () => {
    render(() => <CommitPanel />);
    fireEvent.input(messageBox(), { target: { value: "feat: remembered" } });
    fireEvent.click(commitButton());
    await waitFor(() => expect(messageHistory()).toEqual(["feat: remembered"]));
    fireEvent.click(screen.getByRole("button", { name: "Message history" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /feat: remembered/ }));
    expect(messageBox().value).toBe("feat: remembered");
    await waitFor(() => expect(document.activeElement).toBe(messageBox()));
  });
});
