import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

const { checked, toggleFile } = vi.hoisted(() => {
  const state = { value: true };
  return { checked: state, toggleFile: vi.fn(() => void (state.value = !state.value)) };
});
// The dev machine is slow under load; these tests wait on lazy UI and the mock IPC.
vi.setConfig({ testTimeout: 20_000 });

vi.mock("../../store/selection", () => ({ canSelect: () => true, fileChecked: () => checked.value, toggleFile }));
vi.mock("../../store/snapshots", () => ({
  snapshots: () => ({ r: { revision: 1, changes: [{ path: "a.ts", kind: "modified" }] } }),
  refreshSnapshots: vi.fn(async () => {}),
  onSnapshotApplied: vi.fn(),
}));

import { ipc } from "../../ipc";
import { clearPartial, partialHunks } from "../../store/partialSelection";
import HunksTab from "./HunksTab";

afterEach(() => {
  cleanup();
  clearPartial("r", "a.ts");
  checked.value = true;
  toggleFile.mockClear();
  vi.restoreAllMocks();
});

const tab = { id: "hunks:r:a.ts", type: "hunks", title: "Hunks", params: { repoId: "r", path: "a.ts" } };
const SLOW = { timeout: 5000 };
const hunkBox = (n: number) => screen.getByRole("checkbox", { name: `Include hunk ${n} in the commit` });

describe("<HunksTab>", () => {
  it("starts with every hunk in the commit and stores a partial selection when one is unticked", async () => {
    render(() => <HunksTab tab={tab} />);
    await waitFor(() => expect(screen.getByText("2 of 2 hunks in the commit")).toBeDefined(), SLOW);
    fireEvent.click(hunkBox(2));
    await waitFor(() => expect(screen.getByText("1 of 2 hunks in the commit")).toBeDefined(), SLOW);
    expect(partialHunks("r", "a.ts")).toEqual([{ index: 0 }]);
    // The file stays ticked: it is committed partially.
    expect(toggleFile).not.toHaveBeenCalled();

    fireEvent.click(hunkBox(2));
    await waitFor(() => expect(screen.getByText("2 of 2 hunks in the commit")).toBeDefined(), SLOW);
    expect(partialHunks("r", "a.ts")).toBeUndefined();
  });

  it("unticks the file when no hunk is left and ticks it again for the first hunk", async () => {
    render(() => <HunksTab tab={tab} />);
    await waitFor(() => expect(screen.getByText("2 of 2 hunks in the commit")).toBeDefined(), SLOW);
    fireEvent.click(screen.getByRole("button", { name: "None" }));
    await waitFor(() => expect(screen.getByText("0 of 2 hunks in the commit")).toBeDefined(), SLOW);
    expect(toggleFile).toHaveBeenCalledTimes(1);
    expect(checked.value).toBe(false);
    fireEvent.click(hunkBox(1));
    await waitFor(() => expect(partialHunks("r", "a.ts")).toEqual([{ index: 0 }]), SLOW);
    expect(checked.value).toBe(true);
  });

  it("reverts a hunk in the file text after a confirmation and refuses a file that moved on", async () => {
    const write = vi.spyOn(ipc.files, "writeFile").mockResolvedValue({ mtimeMs: 2 });
    vi.spyOn(ipc.files, "readFile").mockResolvedValue({ text: "stale content\n", binary: false, tooLarge: false, size: 1, mtimeMs: 1, eol: "lf", guard: "ok" });
    render(() => <HunksTab tab={tab} />);
    await waitFor(() => expect(screen.getByText("2 of 2 hunks in the commit")).toBeDefined(), SLOW);
    fireEvent.click(screen.getByRole("button", { name: "Revert hunk 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard hunk" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Discard hunk" })).toBeDefined(), SLOW);
    // The text does not contain the hunk's new lines, so nothing is written.
    expect(write).not.toHaveBeenCalled();
  });
});
