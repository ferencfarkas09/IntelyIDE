import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async () => ({ ipc: (await import("../../store/testing-u2")).normal.ipc }));
vi.mock("../../store/selection", async () => (await import("../../store/testing-u2")).selectionModule);
vi.mock("../../store/snapshots", async () => (await import("../../store/testing-u2")).snapshotsModule);
vi.mock("../../store/workspace", async () => (await import("../../store/testing-u2")).workspaceModule);
vi.mock("../../store/touched", () => ({
  touchedByAgent: (repoId: string, path: string) => (repoId === "backend" && path === ".husky/pre-commit" ? { agentId: "a1", role: "developer", active: false } : undefined),
}));

import { ipc } from "../../ipc";
import { resetActions } from "../../store/actions";
import { installDomStubs, normal, seedStores } from "../../store/testing-u2";
import { CommitPanel } from "./CommitPanel";
import { resetExecDismissal } from "./execSurface";
import { ExecSurfaceBanner } from "./ExecSurfaceBanner";
import { ExecSurfaceConfirm } from "./ExecSurfaceConfirm";
import { resetMessageState } from "./messageState";

installDomStubs();

beforeEach(async () => {
  localStorage.clear();
  resetActions();
  resetMessageState();
  resetExecDismissal();
  normal.reset();
  await seedStores(ipc, {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const banner = () => screen.queryByRole("status", { name: "Changed files that run code" });

describe("<ExecSurfaceBanner>", () => {
  it("warns for a hook file and lists it under its repo", async () => {
    await seedStores(ipc, { backend: [".husky/pre-commit"] });
    render(() => <ExecSurfaceBanner />);
    const box = await screen.findByRole("status", { name: "Changed files that run code" });
    expect(box.textContent).toContain("This changed file runs code when you commit, push, install, lint, test or build: review it before committing");
    expect(within(box).getByText("pre-commit")).not.toBeNull();
    expect(within(box).getByText(".husky")).not.toBeNull();
    expect(within(box).getByText("shop-backend")).not.toBeNull();
  });

  it("stays hidden for normal files and when nothing is ticked", async () => {
    await seedStores(ipc, { backend: ["src/api/routes/index.js"], services: ["locales/hu.json"] });
    render(() => <ExecSurfaceBanner />);
    await waitFor(() => expect(ipc.execSurfaceCheck).toBeDefined());
    await new Promise((r) => setTimeout(r, 20));
    expect(banner()).toBeNull();
  });

  it("groups the files per repo with one badge each", async () => {
    await seedStores(ipc, { backend: [".husky/pre-commit", "package.json", "src/api/routes/index.js"], services: ["vite.config.ts"] });
    render(() => <ExecSurfaceBanner />);
    const box = await screen.findByRole("status", { name: "Changed files that run code" });
    expect(box.textContent).toContain("These changed files run code");
    const groups = box.querySelectorAll<HTMLElement>(".exec-warn__group");
    expect([...groups].map((g) => g.dataset.repo)).toEqual(["backend", "services"]);
    expect(within(groups[0]).getAllByRole("listitem").map((li) => li.textContent)).toEqual([expect.stringContaining("pre-commit"), expect.stringContaining("package.json")]);
    expect(within(groups[1]).getAllByRole("listitem")).toHaveLength(1);
    expect(box.textContent).not.toContain("routes");
  });

  it("marks the files an agent run changed", async () => {
    await seedStores(ipc, { backend: [".husky/pre-commit", "package.json"] });
    render(() => <ExecSurfaceBanner />);
    const box = await screen.findByRole("status", { name: "Changed files that run code" });
    const rows = within(box).getAllByRole("listitem");
    expect(rows[0].textContent).toContain("Changed by an agent");
    expect(rows[1].textContent).not.toContain("Changed by an agent");
  });

  it("can be dismissed and comes back when a new such file is ticked", async () => {
    await seedStores(ipc, { backend: ["package.json"] });
    render(() => <ExecSurfaceBanner />);
    await screen.findByRole("status", { name: "Changed files that run code" });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss warning" }));
    expect(banner()).toBeNull();
    await seedStores(ipc, { backend: ["package.json", "src/a.ts"] });
    await new Promise((r) => setTimeout(r, 20));
    expect(banner()).toBeNull();
    await seedStores(ipc, { backend: ["package.json", ".husky/pre-commit"] });
    const box = await screen.findByRole("status", { name: "Changed files that run code" });
    expect(box.textContent).toContain("These changed files run code");
    expect(box.textContent).toContain("package.json");
  });

  it("forgets a dismissal once nothing is ticked any more", async () => {
    await seedStores(ipc, { backend: ["package.json"] });
    render(() => <ExecSurfaceBanner />);
    await screen.findByRole("status", { name: "Changed files that run code" });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss warning" }));
    await seedStores(ipc, {});
    await seedStores(ipc, { backend: ["package.json"] });
    expect(await screen.findByRole("status", { name: "Changed files that run code" })).not.toBeNull();
  });

  it("shows no warning, and does not break, when the check fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(ipc, "execSurfaceCheck").mockRejectedValue(new Error("boom"));
    await seedStores(ipc, { backend: ["package.json"] });
    render(() => <ExecSurfaceBanner />);
    await new Promise((r) => setTimeout(r, 20));
    expect(banner()).toBeNull();
  });
});

describe("the mock of exec_surface_check", () => {
  it("flags hooks, manifests and tool configs and nothing else", async () => {
    const paths = [".husky/pre-commit", "package.json", "ui/vite.config.ts", ".eslintrc.cjs", ".github/workflows/ci.yml", "build.rs", "src/a.ts", "docs/jest.config.md", "README.md"];
    expect(await ipc.execSurfaceCheck(paths)).toEqual([true, true, true, true, true, true, false, false, false]);
  });
});

describe("the Commit panel with files that run code", () => {
  const commitButton = () => screen.getByRole("button", { name: /^Commit \(/ });
  const messageBox = () => screen.getByLabelText("Commit message") as HTMLTextAreaElement;

  it("never disables the Commit button and commits without a confirmation", async () => {
    await seedStores(ipc, { backend: [".husky/pre-commit", "package.json"] });
    const start = vi.spyOn(ipc, "commitStart");
    render(() => (
      <>
        <CommitPanel />
        <ExecSurfaceConfirm />
      </>
    ));
    await screen.findByRole("status", { name: "Changed files that run code" });
    expect(commitButton().hasAttribute("disabled")).toBe(false);
    fireEvent.input(messageBox(), { target: { value: "chore: scripts" } });
    fireEvent.click(commitButton());
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("Commit and Push lists the files and waits for a yes; Cancel starts nothing", async () => {
    await seedStores(ipc, { backend: [".husky/pre-commit"], services: ["vite.config.ts", "locales/hu.json"] });
    const start = vi.spyOn(ipc, "commitStart");
    render(() => (
      <>
        <CommitPanel />
        <ExecSurfaceConfirm />
      </>
    ));
    fireEvent.input(messageBox(), { target: { value: "chore: scripts" } });
    fireEvent.keyDown(document, { key: "Enter", metaKey: true, altKey: true });
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Commit and push files that run code?");
    expect(dialog.textContent).toContain("pre-commit");
    expect(dialog.textContent).toContain("vite.config.ts");
    expect(dialog.textContent).not.toContain("hu.json");
    expect(start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(start).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Enter", metaKey: true, altKey: true });
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Commit and push" }));
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
  });

  it("Commit and Push without such files asks nothing extra", async () => {
    await seedStores(ipc, { backend: ["src/api/routes/index.js"] });
    const start = vi.spyOn(ipc, "commitStart");
    render(() => (
      <>
        <CommitPanel />
        <ExecSurfaceConfirm />
      </>
    ));
    fireEvent.input(messageBox(), { target: { value: "fix: x" } });
    fireEvent.keyDown(document, { key: "Enter", metaKey: true, altKey: true });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
