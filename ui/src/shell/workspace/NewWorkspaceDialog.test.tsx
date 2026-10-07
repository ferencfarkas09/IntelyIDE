import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({ ipc: {} }));
const pick = vi.hoisted(() => ({ openPicker: vi.fn() }));
vi.mock("./pickerBridge", () => pick);

import { ipc } from "../../ipc";
import { createMockIpc } from "../../ipc/mock";
import { createMockPicker } from "../../ipc/mock/picker";
import { issueMockToken } from "../../ipc/mock/workspaces";
import type { Picked } from "../../ipc/picker";
import { enterEmptyState, workspaceState } from "../../store/workspace";
import { resetWorkspacesForTest, setReloadHook, startWorkspaces } from "../../store/workspaces";
import { toast } from "../../ui-kit";
import { closeNewWorkspace, openNewWorkspace, resetWorkspaceDialogs } from "./dialogs";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const folder = (path: string, over: Partial<Picked> = {}, risks: string[] = []): Picked => ({
  token: issueMockToken({ path, configRisks: risks }, "workspaceRepo"),
  path,
  name: path.split("/").pop()!,
  kind: "repo",
  identity: `id:${path}`,
  root: null,
  main: null,
  warnings: [],
  configRisks: risks,
  remotes: [],
  branch: "main",
  detached: false,
  protectedFolder: null,
  viaSymlink: false,
  gitfileTarget: null,
  ...over,
});

let reload: ReturnType<typeof vi.fn<() => void>>;
let prev: () => void;
let stop: (() => void) | undefined;

async function mount(scenario = "welcome-recents") {
  Object.assign(ipc, createMockIpc(scenario, { delayScale: 0 }), { picker: createMockPicker({ delayScale: 0 }) });
  stop = startWorkspaces(ipc as never);
  await waitFor(() => expect(workspaceState()).toBe(scenario.startsWith("welcome") ? "empty" : "ready"));
  render(() => <NewWorkspaceDialog />);
}
const open = async (req = {}) => {
  openNewWorkspace(req);
  return screen.findByRole("dialog");
};
const rowNames = () => [...document.querySelectorAll<HTMLInputElement>('.wsdlg__row input[aria-label="Display name"]')].map((i) => i.value);

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
  closeNewWorkspace();
  cleanup();
  stop?.();
  stop = undefined;
  setReloadHook(prev);
  vi.restoreAllMocks();
});

describe("<NewWorkspaceDialog>", () => {
  it("starts empty with the name focused and the empty-list text", async () => {
    await mount();
    const d = await open();
    expect(within(d).getByText("No repositories yet. Add folders, scan a folder, or drop them here.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.getAttribute("placeholder")).toBe("My projects"));
  });

  it("validates the name inline: empty, too long, taken", async () => {
    await mount();
    const d = await open();
    const input = within(d).getByPlaceholderText("My projects");
    fireEvent.input(input, { target: { value: "   " } });
    expect(within(d).getByRole("alert").textContent).toBe("Enter a name.");
    fireEvent.input(input, { target: { value: "x".repeat(61) } });
    expect(within(d).getByRole("alert").textContent).toBe("Use at most 60 characters.");
    fireEvent.input(input, { target: { value: "client x" } });
    expect(within(d).getByRole("alert").textContent).toBe("That name is already used.");
    fireEvent.input(input, { target: { value: "Fresh" } });
    expect(within(d).queryByRole("alert")).toBeNull();
  });

  it("Add folders adds rows (name from the first folder), refuses duplicates and shows the notice", async () => {
    await mount();
    const d = await open();
    pick.openPicker.mockResolvedValueOnce([folder("/p/shop-api"), folder("/p/shop-web")]);
    fireEvent.click(within(d).getByRole("button", { name: "Add folders..." }));
    await waitFor(() => expect(rowNames()).toEqual(["shop-api", "shop-web"]));
    expect((within(d).getByPlaceholderText("My projects") as HTMLInputElement).value).toBe("shop-api");
    pick.openPicker.mockResolvedValueOnce([folder("/p/shop-api")]);
    fireEvent.click(await screen.findByRole("button", { name: "Add folders..." }));
    expect((await screen.findByRole("status")).textContent).toBe("Already in this workspace");
    expect(rowNames()).toHaveLength(2);
  });

  it("same-named folders read parent/name; moving and removing rows work, also with Alt+Down", async () => {
    await mount();
    const d = await open({ prefill: [folder("/work/api"), folder("/client/api"), folder("/work/web")] });
    await waitFor(() => expect(rowNames()).toEqual(["work/api", "client/api", "web"]));
    fireEvent.click(within(d).getAllByRole("button", { name: "Move up" })[2]);
    expect(rowNames()).toEqual(["work/api", "web", "client/api"]);
    const first = d.querySelector<HTMLInputElement>('.wsdlg__row input[aria-label="Display name"]')!;
    fireEvent.keyDown(first, { key: "ArrowDown", altKey: true });
    expect(rowNames()).toEqual(["web", "work/api", "client/api"]);
    fireEvent.click(within(d).getByRole("button", { name: "Remove web" }));
    expect(rowNames()).toEqual(["work/api", "client/api"]);
  });

  it("a risky repository needs its own trust tick before anything can be created", async () => {
    await mount();
    const d = await open({ prefill: [folder("/p/risky", {}, ["core.fsmonitor"])] });
    const createOpen = within(d).getByRole("button", { name: "Create and open" }) as HTMLButtonElement;
    expect(createOpen.disabled).toBe(true);
    expect(within(d).getByText(/These settings in its .git\/config are able to start programs: core.fsmonitor/)).toBeTruthy();
    fireEvent.click(within(d).getByRole("checkbox", { name: "I trust this repository" }));
    await waitFor(() => expect(createOpen.disabled).toBe(false));
  });

  it("Create and open creates the workspace with the row edits and opens it (reload)", async () => {
    await mount();
    const d = await open({ prefill: [folder("/p/shop-api"), folder("/p/shop-web")] });
    fireEvent.input(within(d).getByPlaceholderText("My projects"), { target: { value: "Shop" } });
    const nameInputs = d.querySelectorAll<HTMLInputElement>('.wsdlg__row input[aria-label="Display name"]');
    fireEvent.input(nameInputs[1], { target: { value: "Storefront" } });
    fireEvent.click(within(d).getByRole("button", { name: "Create and open" }));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    const created = (await ipc.workspaces.list()).workspaces.find((w) => w.name === "Shop")!;
    expect(created.repos.map((r) => r.name)).toEqual(["shop-api", "Storefront"]);
    expect(created.origin).toBe("created");
  });

  it("Create workspace stays where you are: toast, closed dialog, no reload", async () => {
    await mount();
    const d = await open({ prefill: [folder("/p/alone")] });
    fireEvent.input(within(d).getByPlaceholderText("My projects"), { target: { value: "Alone" } });
    fireEvent.click(within(d).getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(toast.toasts().some((x) => x.title === 'Workspace "Alone" created')).toBe(true));
    expect(reload).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("zero repositories are allowed", async () => {
    await mount();
    const d = await open();
    fireEvent.input(within(d).getByPlaceholderText("My projects"), { target: { value: "Empty one" } });
    fireEvent.click(within(d).getByRole("button", { name: "Create workspace" }));
    await waitFor(async () => expect((await ipc.workspaces.list()).workspaces.find((w) => w.name === "Empty one")?.repos).toEqual([]));
  });

  it("a token Rust no longer accepts marks its row; the rest can be created without it", async () => {
    await mount();
    const good = folder("/p/good");
    const bad = folder("/p/bad");
    const d = await open({ prefill: [good, bad] });
    // expire the second token: the registry reports it in `detail`
    const { default: _unused } = { default: 0 };
    void _unused;
    fireEvent.input(within(d).getByPlaceholderText("My projects"), { target: { value: "Mixed" } });
    const create = vi.spyOn(ipc.workspaces, "create");
    create.mockRejectedValueOnce({ code: "tokenExpired", message: "x", detail: bad.token });
    fireEvent.click(within(d).getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(within(d).getAllByRole("alert").length).toBeGreaterThan(0));
    expect(d.querySelector('.wsdlg__row[data-failed]')?.textContent).toContain("bad");
    create.mockRestore();
    fireEvent.click(within(d).getByRole("button", { name: "Create without the failed repositories" }));
    await waitFor(async () => expect((await ipc.workspaces.list()).workspaces.find((w) => w.name === "Mixed")?.repos.map((r) => r.name)).toEqual(["good"]));
  });

  it("Cancel with changes asks before discarding; without changes it closes at once", async () => {
    await mount();
    let d = await open();
    fireEvent.click(within(d).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    d = await open();
    fireEvent.input(within(d).getByPlaceholderText("My projects"), { target: { value: "Draft" } });
    fireEvent.click(within(d).getByRole("button", { name: "Cancel" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("The changes in this dialog will be lost.");
    await waitFor(() => expect(document.activeElement?.hasAttribute("data-discard-cancel")).toBe(true));
    fireEvent.click(within(confirm).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("the limit of repositories is reported", async () => {
    await mount();
    const many = Array.from({ length: 101 }, (_, i) => folder(`/p/r${i}`));
    await open({ prefill: many });
    expect(document.querySelectorAll(".wsdlg__row")).toHaveLength(100);
    expect(screen.getByRole("status").textContent).toContain("A workspace can hold up to 100 repositories.");
  });

  it("declares itself a drop target while shown; dropped folders become rows", async () => {
    await mount();
    const picker = createMockPicker({ delayScale: 0 });
    Object.assign(ipc, { picker });
    const listen = vi.spyOn(picker, "dropListen");
    await open();
    await waitFor(() => expect(listen).toHaveBeenCalledWith(true));
    await picker.emitDrop(["/Users/example/Projects/api"]);
    await waitFor(() => expect(rowNames()).toEqual(["api"]));
    closeNewWorkspace();
    await waitFor(() => expect(listen).toHaveBeenLastCalledWith(false));
  });
});
