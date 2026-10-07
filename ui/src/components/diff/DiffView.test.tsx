import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async () => ({ ipc: (await import("../../store/testing-u2")).normal.ipc }));
vi.mock("../../store/selection", async () => (await import("../../store/testing-u2")).selectionModule);
vi.mock("../../store/snapshots", async () => (await import("../../store/testing-u2")).snapshotsModule);
vi.mock("../../store/workspace", async () => (await import("../../store/testing-u2")).workspaceModule);

import { ipc, type FileContents } from "../../ipc";
import { installDomStubs, normal, seedStores, setSelected } from "../../store/testing-u2";
import { DiffView } from "./DiffView";

const contents = (o: Partial<FileContents>): FileContents => ({ path: "x", original: "a", modified: "b", binary: false, tooLarge: false, guard: "ok", ...o });

installDomStubs();

beforeEach(async () => {
  localStorage.clear();
  normal.reset();
  await seedStores(ipc, {});
  setSelected(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<DiffView> placeholders", () => {
  it("asks for a selection when no file is selected", () => {
    render(() => <DiffView />);
    expect(screen.getByText("Select a file to see its diff")).not.toBeNull();
  });

  it("explains an untracked folder instead of loading it", () => {
    const load = vi.spyOn(ipc, "fileContents");
    setSelected({ repoId: "admin", path: "src/components/pages/loyalty/" });
    render(() => <DiffView />);
    expect(screen.getByText("Untracked folder")).not.toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("hides secrets until Reveal is clicked, then asks the engine for them", async () => {
    const load = vi.spyOn(ipc, "fileContents");
    setSelected({ repoId: "services", path: "android/app/google-services.json" });
    render(() => <DiffView />);
    await screen.findByText("Secret file hidden");
    expect(load.mock.calls[0][4]).toBeFalsy();
    // The revealed contents are binary here so the test does not need to mount an editor.
    load.mockResolvedValueOnce(contents({ guard: "secret", binary: true }));
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    await screen.findByText("Binary file");
    expect(load.mock.calls.at(-1)?.[4]).toBe(true);
  });

  it.each([
    [{ binary: true }, "Binary file"],
    [{ tooLarge: true }, "File too large to diff"],
    [{ original: "same", modified: "same" }, "No textual changes"],
  ] as const)("shows a placeholder for %j", async (patch, title) => {
    vi.spyOn(ipc, "fileContents").mockResolvedValue(contents(patch));
    setSelected({ repoId: "backend", path: "src/api/routes/index.js" });
    render(() => <DiffView />);
    await screen.findByText(title);
  });

  it("reports a load error and retries", async () => {
    const load = vi.spyOn(ipc, "fileContents").mockRejectedValueOnce({ code: "io", message: "disk gone" });
    setSelected({ repoId: "backend", path: "src/api/routes/index.js" });
    render(() => <DiffView />);
    await screen.findByText("Could not load the diff");
    load.mockResolvedValueOnce(contents({ binary: true }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByText("Could not load the diff")).toBeNull());
    await screen.findByText("Binary file");
  });
  it("hides the editor once the open file leaves the selection", async () => {
    vi.spyOn(ipc, "fileContents").mockResolvedValue(contents({ original: "one\n", modified: "two\n" }));
    setSelected({ repoId: "backend", path: "src/api/routes/index.js" });
    const { container } = render(() => <DiffView />);
    const host = container.querySelector<HTMLElement>(".diff-view__host")!;
    await waitFor(() => expect(host.querySelector(".cm-editor")).not.toBeNull());
    expect(host.hidden).toBe(false);
    setSelected(null);
    await screen.findByText("Select a file to see its diff");
    expect(host.hidden).toBe(true);
    expect(host.querySelector(".cm-editor")).toBeNull();
  });

  it("hides a revealed secret again after switching to another file and back", async () => {
    const load = vi.spyOn(ipc, "fileContents");
    setSelected({ repoId: "services", path: "android/app/google-services.json" });
    render(() => <DiffView />);
    await screen.findByText("Secret file hidden");
    load.mockResolvedValueOnce(contents({ guard: "secret", binary: true }));
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    await screen.findByText("Binary file");
    load.mockResolvedValueOnce(contents({ binary: true }));
    setSelected({ repoId: "backend", path: "src/api/routes/index.js" });
    await waitFor(() => expect(load.mock.calls.at(-1)?.[1]).toBe("src/api/routes/index.js"));
    load.mockRestore();
    setSelected({ repoId: "services", path: "android/app/google-services.json" });
    await screen.findByText("Secret file hidden");
  });
});
