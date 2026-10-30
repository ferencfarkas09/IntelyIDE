import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDomStubs } from "../../store/testing-u2";
import { createMockCheckpoints, setCheckpointsApi, type CheckpointsApi } from "./api";
import { startUndo } from "./HeaderButtons";
import { RestoreDialog } from "./RestoreDialog";
import { SavePointDialog } from "./SavePointDialog";
import { closeRestore, restoreRequest } from "./store";
import { CheckpointTimeline } from "./Timeline";
import CheckpointsSection from "./CheckpointsSection";

const rows = vi.hoisted(() => ({ status: "done" as string }));
vi.mock("../../store/agents", async (orig) => {
  const real = await orig<typeof import("../../store/agents")>();
  return { ...real, agentRow: (id: string | null) => (id ? ({ agentId: id, status: rows.status, repoIds: ["app"], title: "Run" } as unknown as ReturnType<typeof real.agentRow>) : undefined) };
});

installDomStubs();
const isDisabled = (el: HTMLElement) => el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";
let api: CheckpointsApi;
beforeEach(() => {
  rows.status = "done";
  api = createMockCheckpoints();
  setCheckpointsApi(api);
});
afterEach(() => {
  cleanup();
  closeRestore();
  setCheckpointsApi(undefined);
});

describe("<CheckpointTimeline>", () => {
  it("lists the steps newest first with their names and changed files", async () => {
    render(() => <CheckpointTimeline runId="run-1" />);
    const items = await screen.findAllByRole("listitem");
    expect(items[0].textContent).toContain("After the agent's step");
    expect(items[0].textContent).toContain("4 files changed");
    expect(items[1].textContent).toContain("Login screen works");
    expect(items.at(-1)!.textContent).toContain("Before the run");
  });

  it("compares a step read-only and shows the patch of one file", async () => {
    const compare = vi.spyOn(api, "compare");
    const restore = vi.spyOn(api, "restore");
    render(() => <CheckpointTimeline runId="run-1" />);
    const buttons = await screen.findAllByRole("button", { name: "Compare" });
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(compare).toHaveBeenCalledWith("run-1", "app", 2, 3));
    fireEvent.click(await screen.findByRole("button", { name: /src\/screens\/Login\.tsx/ }));
    expect(await screen.findByLabelText("Changes in src/screens/Login.tsx")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Since this step" }));
    await waitFor(() => expect(compare).toHaveBeenLastCalledWith("run-1", "app", 3, null));
    expect(restore).not.toHaveBeenCalled();
  });

  it("Undo last step opens the dry run of the step before the last change", async () => {
    render(() => <CheckpointTimeline runId="run-1" />);
    const undo = await screen.findByRole("button", { name: "Undo last step" });
    await waitFor(() => expect(isDisabled(undo)).toBe(false));
    fireEvent.click(undo);
    expect(restoreRequest()).toEqual({ runId: "run-1", seq: 2, mode: "undo" });
  });

  it("offers no undo or restore while the run works", async () => {
    rows.status = "running";
    render(() => <CheckpointTimeline runId="run-1" />);
    const undo = await screen.findByRole("button", { name: "Undo last step" });
    expect(isDisabled(undo)).toBe(true);
  });
});

describe("startUndo", () => {
  it("picks the target from the list and never restores by itself", async () => {
    const restore = vi.spyOn(api, "restore");
    expect(await startUndo("run-2")).toBe(true);
    expect(restoreRequest()?.seq).toBe(2);
    expect(restore).not.toHaveBeenCalled();
  });

  it("says so when there is nothing to undo", async () => {
    setCheckpointsApi({ ...api, list: async () => [{ seq: 0, kind: "start", label: null, createdAt: 1, repos: [], changed: 0 }] });
    expect(await startUndo("run-3")).toBe(false);
    expect(restoreRequest()).toBeUndefined();
  });
});

describe("<RestoreDialog>", () => {
  const show = () => render(() => <RestoreDialog open={true} runId="run-1" seq={1} mode="pick" onClose={() => {}} />);

  it("lists first, keeps later edits by default and restores only after the typed confirmation", async () => {
    const restore = vi.spyOn(api, "restore");
    show();
    expect(await screen.findByText(/Dry run: 4 files differ/)).toBeTruthy();
    expect(screen.getByTestId("cp-conflicts").textContent).toContain("1 file was changed after the run's last step");
    expect(screen.getByText("kept: you changed it later")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Restore 3 files" });
    expect(isDisabled(button)).toBe(true);
    fireEvent.input(screen.getByLabelText("Confirm the restore"), { target: { value: "App" } });
    expect(isDisabled(button)).toBe(true);
    fireEvent.input(screen.getByLabelText("Confirm the restore"), { target: { value: "app" } });
    fireEvent.click(screen.getByRole("button", { name: "Restore 3 files" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith("run-1", 1, { confirm: true, overwriteConflicts: false }));
    expect(await screen.findByText("Restored 3 files.")).toBeTruthy();
    expect(screen.getByText(/1 file was kept because you changed it later/)).toBeTruthy();
  });

  it("overwrites later edits only when the box is ticked", async () => {
    const restore = vi.spyOn(api, "restore");
    show();
    fireEvent.click(await screen.findByRole("checkbox", { name: /Also put this file back/ }));
    fireEvent.input(screen.getByLabelText("Confirm the restore"), { target: { value: "app" } });
    fireEvent.click(screen.getByRole("button", { name: "Restore 4 files" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith("run-1", 1, { confirm: true, overwriteConflicts: true }));
  });

  it("writes protected config files back only when each one is ticked", async () => {
    await api.setProtectConfig(true);
    const restoreConfig = vi.spyOn(api, "restoreConfig");
    show();
    await screen.findByRole("checkbox", { name: /\.env\.local in app/ });
    fireEvent.input(screen.getByLabelText("Confirm the restore"), { target: { value: "app" } });
    fireEvent.click(screen.getByRole("button", { name: "Restore 3 files" }));
    await screen.findByText("Restored 3 files.");
    expect(restoreConfig).not.toHaveBeenCalled();

    cleanup();
    show();
    fireEvent.click(await screen.findByRole("checkbox", { name: /\.env\.local in app/ }));
    fireEvent.input(screen.getByLabelText("Confirm the restore"), { target: { value: "app" } });
    fireEvent.click(screen.getByRole("button", { name: "Restore 4 files" }));
    await waitFor(() => expect(restoreConfig).toHaveBeenCalledWith("run-1", 1, "app", [".env.local"], true));
  });

  it("refuses while the run works", async () => {
    rows.status = "needsYou";
    show();
    expect(await screen.findByText(/This run is still working/)).toBeTruthy();
    fireEvent.input(await screen.findByLabelText("Confirm the restore"), { target: { value: "app" } });
    const button = screen.getByRole("button", { name: "Restore 3 files" });
    expect(isDisabled(button)).toBe(true);
  });

  it("shows the host's refusal in plain words", async () => {
    setCheckpointsApi({ ...api, restore: async () => Promise.reject(Object.assign(new Error("x"), { code: "repoBusy" })) });
    show();
    fireEvent.input(await screen.findByLabelText("Confirm the restore"), { target: { value: "app" } });
    fireEvent.click(screen.getByRole("button", { name: "Restore 3 files" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Another run is still working");
  });
});

describe("<SavePointDialog>", () => {
  it("saves a cleaned label", async () => {
    const save = vi.spyOn(api, "save");
    const onClose = vi.fn();
    render(() => <SavePointDialog open={true} runId="run-1" onClose={onClose} />);
    fireEvent.input(screen.getByLabelText("Name of the save point"), { target: { value: "  login\t  works " } });
    fireEvent.click(screen.getByRole("button", { name: "Save point" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("run-1", "login works"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe("<CheckpointsSection>", () => {
  it("keeps the config protection off until it is switched on, and names the files", async () => {
    render(() => <CheckpointsSection />);
    const sw = await screen.findByRole("switch", { name: "Also protect ignored config files" });
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"));
    expect(screen.getByText(".env.local")).toBeTruthy();
    fireEvent.click(sw);
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
    expect((await api.settings()).protectConfig).toBe(true);
  });
});
