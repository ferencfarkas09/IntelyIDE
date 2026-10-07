import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Picked } from "../../ipc/picker";
import { createMockPicker, MOCK_HOME, type MockPicker } from "../../ipc/mock/picker";

const h = vi.hoisted(() => ({ picker: undefined as unknown as MockPicker }));
vi.mock("../../ipc", () => ({
  ipc: {
    get picker() {
      return h.picker;
    },
  },
}));

import { openPathPicker, PathField, PathPickerHost, resetPathPicker, wasTrusted } from "./index";

const P = `${MOCK_HOME}/Projects`;

function setup(opts: Parameters<typeof createMockPicker>[0] = {}) {
  h.picker = createMockPicker({ delayScale: 0, ...opts });
  return render(() => <PathPickerHost />);
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  h.picker = createMockPicker({ delayScale: 0 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetPathPicker();
  cleanup();
});

const dialog = () => screen.findByRole("dialog");
const listbox = () => screen.findByRole("listbox");
const option = async (name: string) => within(await listbox()).findByRole("option", { name: new RegExp(`^${name}`) });
const key = (el: Element, k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(el, { key: k, ...init });

async function goTo(path: string) {
  const input = await screen.findByRole("textbox", { name: "Go to path" });
  fireEvent.input(input, { target: { value: path } });
  fireEvent.submit(input.closest("form")!);
}

describe("path picker: browse tab", () => {
  it("opens in the browser when there is no native dialog, with breadcrumbs ending in the current folder", async () => {
    setup();
    void openPathPicker({ kind: "folder", purpose: "workspaceRoot" });
    expect(await screen.findByRole("dialog", { name: "Choose a folder" })).toBeTruthy();
    await option("Projects");
    const nav = screen.getByRole("navigation", { name: "Path" });
    expect(within(nav).getByText("example").getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("button", { name: "Users" })).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("walks with the keyboard: arrows, Enter into a folder, Backspace up, type-ahead, Home and End", async () => {
    setup();
    void openPathPicker({ kind: "folder", purpose: "workspaceRoot" });
    const list = await listbox();
    await option("certs");
    key(list, "ArrowDown");
    expect((await option("certs")).getAttribute("aria-selected")).toBe("true");
    key(list, "End");
    expect((await option("Projects")).getAttribute("aria-selected")).toBe("true");
    key(list, "Home");
    expect((await option("certs")).getAttribute("aria-selected")).toBe("true");
    key(list, "p");
    expect((await option("Projects")).getAttribute("aria-selected")).toBe("true");
    key(list, "Enter");
    await option("api");
    expect(screen.getByRole("navigation", { name: "Path" }).textContent).toContain("Projects");
    key(await listbox(), "Backspace");
    await option("Projects");
    expect(screen.getByRole("navigation", { name: "Path" }).textContent).not.toContain("Projects");
  });

  it("marks Git repositories and toggles hidden folders", async () => {
    setup();
    void openPathPicker({ kind: "folder", purpose: "workspaceRoot" });
    const list = await listbox();
    key(list, "p");
    key(list, "Enter");
    const api = await option("api");
    expect(within(api).getByText("Git")).toBeTruthy();
    expect(within(await option("docs")).queryByText("Git")).toBeNull();
    expect(within(await option("link-to-api")).getByText("Link")).toBeTruthy();
    expect(screen.queryByRole("option", { name: /^\.git/ })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show hidden folders" }));
    await waitFor(() => expect(h.picker).toBeTruthy());
  });

  it("shows the macOS explainer for a guarded folder and recovers after Try again", async () => {
    setup();
    void openPathPicker({ kind: "folder", purpose: "workspaceRoot" });
    const list = await listbox();
    await option("Documents");
    key(list, "d");
    key(list, "o");
    key(list, "c");
    key(list, "Enter");
    expect(await screen.findByText("macOS blocked access to this folder")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
    expect(h.picker.privacyOpened()).toBe(1);
    h.picker.grant(`${MOCK_HOME}/Documents`);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await option("Contracts");
    expect(screen.queryByText("macOS blocked access to this folder")).toBeNull();
  });

  it("says Waiting for macOS when a listing is slow", async () => {
    setup({ delayScale: 0.7 });
    void openPathPicker({ kind: "folder", purpose: "workspaceRoot" });
    // Navigate by typing: Projects, then slow.
    const list = await listbox();
    key(list, "p");
    key(list, "Enter");
    await option("slow");
    key(await listbox(), "s");
    key(await listbox(), "l");
    key(await listbox(), "Enter");
    expect(await screen.findByText(/Waiting for macOS/, undefined, { timeout: 3000 })).toBeTruthy();
    await option("inner");
  });

  it("jumps to the nearest existing folder when the current one is gone", async () => {
    setup();
    void openPathPicker({ kind: "folder", purpose: "workspaceRoot" });
    const list = await listbox();
    await option("Projects");
    key(list, "p");
    key(list, "Enter");
    await option("api");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await option("Projects");
    delete h.picker.tree().children!.Users.children!.example.children!.Projects;
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    await screen.findByText("This folder no longer exists.");
    await option("certs");
  });

  it("shows the test-jail state outside the fixture and starts inside it", async () => {
    setup({ mode: "e2e" });
    void openPathPicker({ kind: "folder", purpose: "workspaceRoot" });
    await option("api");
    expect(screen.getByRole("navigation", { name: "Path" }).textContent).toContain("Projects");
    await goTo(MOCK_HOME);
    expect(await screen.findByText("Outside the test fixture folder.")).toBeTruthy();
  });

  it("cancels with Cancel and rejects a second picker while one is open", async () => {
    setup();
    const first = openPathPicker({ kind: "folder", purpose: "workspaceRoot" });
    await dialog();
    await expect(openPathPicker({ kind: "folder", purpose: "workspaceRoot" })).rejects.toMatchObject({ code: "busy" });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await first).toBeNull();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("path picker: result card", () => {
  it("normalises a pasted path and confirms a repository", async () => {
    setup();
    const result = openPathPicker({ kind: "folder", purpose: "workspaceRoot" });
    await goTo(`  "~/Projects/api"  `);
    expect(await screen.findByText("Git repository")).toBeTruthy();
    expect(screen.getByText(`${P}/api`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
    const got = (await result)!;
    expect(got[0].path).toBe(`${P}/api`);
    expect(wasTrusted(got[0])).toBe(false);
  });

  it("reports validation errors inline", async () => {
    setup();
    void openPathPicker({ kind: "folder", purpose: "workspaceRoot" });
    await goTo("/definitely/not/here");
    expect(await screen.findByText("This folder does not exist.")).toBeTruthy();
    await goTo("relative/path");
    expect(await screen.findByText("That is not a valid path.")).toBeTruthy();
  });

  it("gates a risky repository behind the trust checkbox", async () => {
    setup();
    const result = openPathPicker({ kind: "folder", purpose: "workspaceRoot" });
    await goTo(`${P}/client-x`);
    expect(await screen.findByText("This repository's Git settings can run programs")).toBeTruthy();
    expect(screen.getByText("core.fsmonitor")).toBeTruthy();
    const use = screen.getByRole("button", { name: "Use this folder" });
    expect((use as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Tick the box to add this repository.")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "I trust this repository" }));
    expect((use as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(use);
    const got = (await result)!;
    expect(wasTrusted(got[0])).toBe(true);
  });

  it("offers the repository root for a subfolder", async () => {
    setup();
    const result = openPathPicker({ kind: "folder", purpose: "workspaceRoot" });
    await goTo(`${P}/api/src`);
    expect(await screen.findByText("Inside the repository api")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use the repository root" }));
    const got = (await result)!;
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: "repo", path: `${P}/api` });
  });

  it("offers the parent for a .git folder and refuses a bare repository", async () => {
    setup();
    void openPathPicker({ kind: "folder", purpose: "workspaceRoot" });
    await goTo(`${P}/api/.git`);
    expect(await screen.findByText("This is a .git folder.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Use the repository root" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Choose another folder" }));
    await goTo(`${P}/legacy.git`);
    expect((await screen.findByRole("alert")).textContent).toContain("Bare repository");
    expect((screen.getByRole("button", { name: "Use this folder" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says a too-broad folder is too broad", async () => {
    setup();
    h.picker.tree().children!.Users.children!.example.git = { shape: "repo", branch: "main" };
    void openPathPicker({ kind: "folder", purpose: "workspaceRoot" });
    await goTo(MOCK_HOME);
    expect(await screen.findByText("This folder is too broad to be a repository.")).toBeTruthy();
  });

  it("shows warnings above the confirm button, including limited worktree support", async () => {
    setup();
    void openPathPicker({ kind: "folder", purpose: "workspaceRoot" });
    await goTo(`${P}/feature-wt`);
    expect(await screen.findByText("Linked worktree of api")).toBeTruthy();
    expect(screen.getByText("Worktrees and submodules work with limits.")).toBeTruthy();
  });

  it("initialises a folder after the typed name and then confirms the new repository", async () => {
    setup();
    const result = openPathPicker({ kind: "folder", purpose: "workspaceRoot" });
    await goTo(`${P}/docs`);
    expect(await screen.findByText("Not a Git repository")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Use this folder" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Initialize Git here..." }));
    const input = await screen.findByLabelText('Type the folder name "docs" to confirm.');
    const run = screen.getByRole("button", { name: "Initialize" });
    expect((run as HTMLButtonElement).disabled).toBe(true);
    fireEvent.input(input, { target: { value: "docs" } });
    expect((run as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(run);
    await waitFor(() => expect((screen.getByRole("button", { name: "Use this folder" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
    expect((await result)![0]).toMatchObject({ kind: "repo", path: `${P}/docs` });
  });

  it("disables init in read-only mode and says why", async () => {
    setup({ mode: "readOnly" });
    void openPathPicker({ kind: "folder", purpose: "workspaceRoot" });
    await goTo(`${P}/docs`);
    expect(await screen.findByText("Read-only mode: nothing can be created.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Initialize Git here..." }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("goes back to the browser with Choose another folder", async () => {
    setup();
    void openPathPicker({ kind: "folder", purpose: "workspaceRoot" });
    await goTo(`${P}/api`);
    await screen.findByText("Git repository");
    fireEvent.click(screen.getByRole("button", { name: "Choose another folder" }));
    await listbox();
    expect(screen.queryByText("Git repository")).toBeNull();
  });
});

describe("path picker: multi select and files", () => {
  it("selects several folders with Space and reviews all of them", async () => {
    setup();
    const result = openPathPicker({ kind: "folders", purpose: "workspaceRepo" });
    const list = await listbox();
    expect(list.getAttribute("aria-multiselectable")).toBe("true");
    key(list, "p");
    key(list, "Enter");
    await option("api");
    fireEvent.click(await option("api"), { metaKey: true });
    fireEvent.click(await option("shop-frontend"), { metaKey: true });
    expect(await screen.findByText("2 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Choose (2)" }));
    await screen.findAllByRole("article");
    expect(screen.getAllByRole("article")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Choose (2)" }));
    const got = (await result)!;
    expect(got.map((g: Picked) => g.name).sort()).toEqual(["api", "shop-frontend"]);
  });

  it("picks a file with the extension filter and returns it without a review step", async () => {
    setup();
    const result = openPathPicker({ kind: "file", purpose: "file:caFile", extensions: ["pem"] });
    const list = await listbox();
    expect(await screen.findByRole("dialog", { name: "Choose a file" })).toBeTruthy();
    key(list, "c");
    key(list, "Enter");
    const file = await option("ca.pem");
    expect(screen.queryByRole("option", { name: /^client\.key/ })).toBeNull();
    fireEvent.click(file);
    key(await listbox(), "Enter");
    const got = (await result)!;
    expect(got[0]).toMatchObject({ kind: "file", path: `${MOCK_HOME}/certs/ca.pem` });
  });
});

describe("path picker: native tab", () => {
  it("uses the system dialog first, reviews its answer, and keeps the dialog on cancel", async () => {
    setup({ native: true });
    const result = openPathPicker({ kind: "folder", purpose: "workspaceRoot" });
    expect((await screen.findByRole("radio", { name: "Finder" })).getAttribute("aria-checked")).toBe("true");
    h.picker.script({ cancel: true }, { paths: [`${P}/api`] });
    fireEvent.click(screen.getByRole("button", { name: "Choose in Finder..." }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Choose in Finder..." }).getAttribute("aria-busy")).toBeNull());
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Choose in Finder..." }));
    await screen.findByText("Git repository");
    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
    expect((await result)![0].path).toBe(`${P}/api`);
  });

  it("falls back to the browser with a note when the system dialog fails", async () => {
    setup({ native: true });
    void openPathPicker({ kind: "folder", purpose: "workspaceRoot" });
    h.picker.script({ fail: true });
    fireEvent.click(await screen.findByRole("button", { name: "Choose in Finder..." }));
    expect(await screen.findByText("The system dialog could not be opened. Browse inside IntelyIDE instead.")).toBeTruthy();
    await listbox();
  });

  it("lets the user switch to Browse in IntelyIDE", async () => {
    setup({ native: true });
    void openPathPicker({ kind: "folder", purpose: "workspaceRoot" });
    fireEvent.click(await screen.findByRole("radio", { name: "Browse in IntelyIDE" }));
    await listbox();
  });
});

describe("PathField", () => {
  function Host(props: { initial?: string }) {
    const [v, setV] = createSignal(props.initial ?? "");
    return <PathField value={v()} onInput={setV} purpose="file:caFile" extensions={["pem"]} label="CA file" aria-label="CA path" />;
  }

  it("lets the user type and Browse fills the canonical path; cancel leaves the value", async () => {
    h.picker = createMockPicker({ delayScale: 0, native: true });
    render(() => (
      <>
        <Host initial="/etc/ssl/own.pem" />
        <PathPickerHost />
      </>
    ));
    const input = screen.getByRole("textbox", { name: "CA path" });
    fireEvent.input(input, { target: { value: "/typed.pem" } });
    expect((input as HTMLInputElement).value).toBe("/typed.pem");
    h.picker.script({ cancel: true }, { paths: [`${MOCK_HOME}/certs/ca.pem`] });
    fireEvent.click(screen.getByRole("button", { name: "Browse for CA file" }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose in Finder..." }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((input as HTMLInputElement).value).toBe("/typed.pem");
    fireEvent.click(screen.getByRole("button", { name: "Browse for CA file" }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose in Finder..." }));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(`${MOCK_HOME}/certs/ca.pem`));
  });

  it("shows the explainer when the picked folder is guarded", async () => {
    h.picker = createMockPicker({ delayScale: 0 });
    render(() => (
      <>
        <Host />
        <PathPickerHost />
      </>
    ));
    fireEvent.click(screen.getByRole("button", { name: "Browse for CA file" }));
    await goTo(`${MOCK_HOME}/Documents/Contracts/x.pem`);
    expect(await screen.findByText("macOS blocked access to this folder")).toBeTruthy();
  });
});
