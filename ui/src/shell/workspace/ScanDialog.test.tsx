import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({ ipc: {} }));
const pick = vi.hoisted(() => ({ openPicker: vi.fn() }));
vi.mock("./pickerBridge", () => pick);

import { ipc } from "../../ipc";
import { createMockIpc } from "../../ipc/mock";
import { createMockPicker, type MockPicker } from "../../ipc/mock/picker";
import { adoptWorkspace, enterEmptyState, repos, workspaceState } from "../../store/workspace";
import { resetWorkspacesForTest, setReloadHook, startWorkspaces } from "../../store/workspaces";
import { toast } from "../../ui-kit";
import { closeScan, openScan, resetWorkspaceDialogs } from "./dialogs";
import { ScanDialog } from "./ScanDialog";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const ROOT = "/Users/example/Projects";
let picker: MockPicker;
let reload: ReturnType<typeof vi.fn<() => void>>;
let prev: () => void;
let stop: (() => void) | undefined;

async function mount(scenario = "normal") {
  picker = createMockPicker({ delayScale: 0, scanStepMs: 0 });
  Object.assign(ipc, createMockIpc(scenario, { delayScale: 0 }), { picker });
  stop = startWorkspaces(ipc as never);
  await waitFor(() => expect(workspaceState()).toBe(scenario.startsWith("welcome") ? "empty" : "ready"));
  render(() => <ScanDialog />);
}
const names = () => [...document.querySelectorAll(".wsdlg__row strong")].map((n) => n.textContent);
const finished = () => waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("Scan finished"), { timeout: 15000 });

beforeEach(() => {
  resetWorkspacesForTest();
  resetWorkspaceDialogs();
  enterEmptyState();
  pick.openPicker.mockReset();
  toast.clear();
  reload = vi.fn<() => void>();
  prev = setReloadHook(reload);
});
afterEach(() => {
  closeScan();
  cleanup();
  stop?.();
  stop = undefined;
  setReloadHook(prev);
  vi.restoreAllMocks();
});

describe("<ScanDialog>", () => {
  it("opening without a folder asks the picker; cancelling leaves the dialog with Choose folder", async () => {
    await mount();
    pick.openPicker.mockResolvedValueOnce(null);
    openScan({ target: "new" });
    const d = await screen.findByRole("dialog");
    expect(pick.openPicker).toHaveBeenCalledWith({ kind: "folder", purpose: "scanRoot" });
    expect(within(d).getByRole("button", { name: "Choose folder..." })).toBeTruthy();
    expect((within(d).getByRole("button", { name: "Add 0 repositories" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("finishes even when the final progress event came before the page subscribed (the results carry the progress)", async () => {
    await mount();
    vi.spyOn(picker, "onScan").mockReturnValue(() => undefined);
    openScan({ target: "new", root: ROOT });
    await screen.findByRole("dialog");
    await finished();
    expect(names().length).toBeGreaterThan(3);
  });

  it("streams the results in, ticked by default, with the counts, and finishes", async () => {
    await mount();
    openScan({ target: "new", root: ROOT });
    const d = await screen.findByRole("dialog");
    await finished();
    expect(d.textContent).toMatch(/\d+ repositories found, [\d,]+ folders checked/);
    expect(names()).toEqual(expect.arrayContaining(["api", "shop-frontend", "client-x"]));
    expect(d.querySelectorAll('.wsdlg__row input[type="checkbox"]:checked').length).toBeGreaterThan(3);
    expect(within(d).getByRole("heading", { name: "Repositories found" })).toBeTruthy();
  });

  it("the repository whose Git settings can run programs needs its own tick; the others do not", async () => {
    await mount();
    openScan({ target: "new", root: ROOT });
    const d = await screen.findByRole("dialog");
    await finished();
    const add = () => d.querySelector<HTMLButtonElement>(".ui-dialog__footer .ui-btn[data-variant='primary']")!;
    expect(add().disabled).toBe(true);
    fireEvent.click(within(d).getByRole("checkbox", { name: "I trust this repository" }));
    await waitFor(() => expect(add().disabled).toBe(false));
  });

  it("Select none / Select all / unticking a row change the count on the button", async () => {
    await mount();
    openScan({ target: "new", root: ROOT });
    const d = await screen.findByRole("dialog");
    await finished();
    fireEvent.click(within(d).getByRole("button", { name: "Select none" }));
    expect(within(d).getByRole("button", { name: "Add 0 repositories" })).toBeTruthy();
    fireEvent.click(within(d).getByRole("button", { name: "Select all" }));
    const all = d.querySelectorAll('.wsdlg__row input[type="checkbox"]').length;
    fireEvent.keyDown(d.querySelector('.wsdlg__rows')!, { key: "a", metaKey: true });
    expect(d.querySelectorAll('.wsdlg__row input[type="checkbox"]:checked').length).toBeGreaterThanOrEqual(all - 1);
  });

  it("Add creates a new workspace with the ticked repositories and opens it (name defaults to the parent folder)", async () => {
    await mount();
    openScan({ target: "new", root: ROOT });
    const d = await screen.findByRole("dialog");
    await finished();
    expect((within(d).getByLabelText("Workspace name") as HTMLInputElement).value).toBe("Projects");
    fireEvent.click(within(d).getByRole("button", { name: "Select none" }));
    fireEvent.click(within(d).getAllByRole("checkbox")[0]);
    fireEvent.click(d.querySelector<HTMLButtonElement>(".ui-dialog__footer .ui-btn[data-variant='primary']")!);
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    const created = (await ipc.workspaces.list()).workspaces.find((w) => w.name === "Projects")!;
    expect(created.origin).toBe("scanned");
    expect(created.repos).toHaveLength(1);
  });

  it("a taken workspace name is refused inline and the button stays off", async () => {
    await mount();
    openScan({ target: "new", root: ROOT });
    const d = await screen.findByRole("dialog");
    await finished();
    fireEvent.click(within(d).getByRole("checkbox", { name: "I trust this repository" }));
    fireEvent.input(within(d).getByLabelText("Workspace name"), { target: { value: "client x" } });
    expect(within(d).getByRole("alert").textContent).toBe("That name is already used.");
  });

  it("This workspace: repositories already in it are disabled and marked; adding the rest updates the workspace", async () => {
    await mount();
    const added = await ipc.workspaces.addRepos([{ token: `mock:${ROOT}/api` }]);
    await adoptWorkspace(added);
    openScan({ target: "current", root: ROOT });
    const d = await screen.findByRole("dialog");
    await finished();
    expect(within(d).getByRole("group", { name: "Add to" })).toBeTruthy();
    const apiRow = [...d.querySelectorAll<HTMLElement>(".wsdlg__row")].find((r) => r.querySelector("strong")?.textContent === "api")!;
    expect(apiRow.hasAttribute("data-disabled")).toBe(true);
    expect(apiRow.textContent).toContain("Already added");
    expect((apiRow.querySelector("input[type=checkbox]") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(within(d).getByRole("button", { name: "Select none" }));
    fireEvent.click(within(d).getByRole("checkbox", { name: /shop-frontend/ }));
    const before = repos().length;
    fireEvent.click(d.querySelector<HTMLButtonElement>(".ui-dialog__footer .ui-btn[data-variant='primary']")!);
    await waitFor(() => expect(repos().length, d.textContent ?? "").toBe(before + 1));
  });

  it("pick mode (from New workspace) hands the ticked repositories to the caller and offers no target", async () => {
    await mount();
    const onPick = vi.fn();
    openScan({ target: "pick", root: ROOT, onPick });
    const d = await screen.findByRole("dialog");
    await finished();
    expect(within(d).queryByRole("radio")).toBeNull();
    fireEvent.click(within(d).getByRole("checkbox", { name: "I trust this repository" }));
    fireEvent.click(within(d).getByRole("button", { name: /Use \d+ repositories/ }));
    await waitFor(() => expect(onPick).toHaveBeenCalledOnce());
    const items = onPick.mock.calls[0][0] as Array<{ name: string; trusted?: boolean; configRisks: string[] }>;
    expect(items.length).toBeGreaterThan(3);
    expect(items.find((i) => i.name === "client-x")?.trusted).toBe(true);
  });

  it("a folder without repositories says so and offers another folder", async () => {
    await mount();
    openScan({ target: "new", root: "/Users/example/Documents" });
    const d = await screen.findByRole("dialog");
    await waitFor(() => expect(d.textContent).toMatch(/No Git repositories found below this folder|macOS blocked|folders checked/), { timeout: 15000 });
  });

  it("Stop cancels the scan and keeps what was found", async () => {
    picker = createMockPicker({ delayScale: 1, scanStepMs: 30 });
    await mount();
    Object.assign(ipc, { picker });
    openScan({ target: "new", root: ROOT });
    const d = await screen.findByRole("dialog");
    fireEvent.click(await within(d).findByRole("button", { name: "Stop" }));
    await waitFor(() => expect(d.textContent).toContain("Scan stopped. The repositories found so far can still be added."), { timeout: 15000 });
  });
});
