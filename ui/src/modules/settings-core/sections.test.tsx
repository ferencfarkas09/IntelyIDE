import { cleanup, configure, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async (orig) => {
  const mod = await orig<typeof import("../../ipc")>();
  const { createMockIpc } = await import("../../ipc/mock");
  return { ...mod, ipc: createMockIpc("normal", { delayScale: 0 }) };
});

const pick = vi.hoisted(() => ({ openPicker: vi.fn() }));
vi.mock("../../shell/workspace/pickerBridge", () => pick);

import { issueMockToken } from "../../ipc/mock/workspaces";
import { allCommands, registerCommand, resetCommands } from "../../platform/commands";
import { registerShortcut, resetKeymap } from "../../platform/keymap";
import { loadWorkspace, repos, workspace } from "../../store/workspace";
import { setLocale } from "../../i18n";
import { toast } from "../../ui-kit";
import AboutSection from "./AboutSection";
import AppearanceSection from "./AppearanceSection";
import EditorSection from "./EditorSection";
import GeneralSection from "./GeneralSection";
import KeyboardSection from "./KeyboardSection";
import SafetySection from "./SafetySection";

beforeEach(async () => {
  await loadWorkspace();
});

// jsdom has no ResizeObserver; the segmented control measures its thumb with one.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

// The shared dev machine is heavily loaded; a lazy chunk may take seconds to arrive.
configure({ asyncUtilTimeout: 15000 });
vi.setConfig({ testTimeout: 30000 });

afterEach(() => {
  cleanup();
  resetCommands();
  resetKeymap();
  setLocale("en");
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-density");
  document.documentElement.removeAttribute("data-accent");
  document.getElementById("intely-accent")?.remove();
});

describe("<GeneralSection>", () => {
  const folder = (path: string) => ({
    token: issueMockToken({ path }, "workspaceRepo"),
    path,
    name: path.split("/").pop()!,
    kind: "repo" as const,
    identity: "1:1",
    root: null,
    main: null,
    warnings: [],
    configRisks: [],
    remotes: [],
    branch: "main",
    detached: false,
    protectedFolder: null,
    viaSymlink: false,
    gitfileTarget: null,
  });

  it("lists the workspace repos and edits them: reorder, remove with confirmation, add through the picker", async () => {
    render(() => <GeneralSection />);
    const list = await screen.findByRole("list", { name: "Workspace repositories" });
    const names = () => within(list).getAllByRole("listitem").map((li) => li.querySelector(".repolist__name")!.textContent);
    const first = names()[0]!;
    const second = names()[1]!;

    fireEvent.click(within(list).getByRole("button", { name: `Move ${first} down` }));
    await waitFor(() => expect(names().slice(0, 2)).toEqual([second, first]));

    fireEvent.click(within(list).getByRole("button", { name: `Remove ${second}` }));
    expect(within(list).getByRole("alert").textContent).toContain("Nothing on disk is deleted");
    fireEvent.click(within(list).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(names()).not.toContain(second));

    const before = repos().length;
    // No typed path any more: the picker answers, Rust redeems the token.
    expect(screen.queryByLabelText("Repository path")).toBeNull();
    pick.openPicker.mockResolvedValueOnce([folder("/tmp/fresh")]);
    fireEvent.click(screen.getByRole("button", { name: "Add repository..." }));
    await waitFor(() => expect(repos()).toHaveLength(before + 1));
    expect(repos().at(-1)).toMatchObject({ name: "fresh", path: "/tmp/fresh" });
    await waitFor(() => expect(toast.toasts().some((x) => x.title === "1 repository added")).toBe(true));

    // The same folder again is refused inline.
    pick.openPicker.mockResolvedValueOnce([folder("/tmp/fresh")]);
    fireEvent.click(screen.getByRole("button", { name: "Add repository..." }));
    expect((await screen.findByText("Already in this workspace.")).getAttribute("role")).toBe("alert");
    expect(repos()).toHaveLength(before + 1);

    // A cancelled picker changes nothing.
    pick.openPicker.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole("button", { name: "Add repository..." }));
    await Promise.resolve();
    expect(repos()).toHaveLength(before + 1);
  });

  it("declares itself a drop target while shown and offers Scan in this workspace", async () => {
    const scan = vi.fn();
    registerCommand({ id: "workspace.scan", title: "scan", group: "Workspace", run: scan });
    const { ipc } = await import("../../ipc");
    const listen = vi.spyOn(ipc.picker, "dropListen");
    const view = render(() => <GeneralSection />);
    await screen.findByRole("list", { name: "Workspace repositories" });
    expect(listen).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Scan a folder..." }));
    expect(scan).toHaveBeenCalledWith({ target: "current" });
    view.unmount();
    expect(listen).toHaveBeenLastCalledWith(false);
  });

  it("recolours a repo from the palette", async () => {
    render(() => <GeneralSection />);
    const repo = repos()[0];
    fireEvent.click(await screen.findByRole("button", { name: `Colour of ${repo.name}` }));
    const target = ["#4caf7d", "#8b6cf0"].find((c) => c !== repo.color.toLowerCase())!;
    fireEvent.click(screen.getByRole("button", { name: target }));
    await waitFor(() => expect(repos()[0].color).toBe(target));
  });

  it("switches the language from the searchable list and shows the machine-translation notice", async () => {
    render(() => <GeneralSection />);
    const list = await screen.findByRole("listbox", { name: "Language" });
    // Own-language names, filtered by search (also by the English name).
    fireEvent.input(screen.getByLabelText("Search languages"), { target: { value: "hungar" } });
    const options = within(list).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain("Magyar");
    fireEvent.click(options[0]);
    await waitFor(() => expect(localStorage.getItem("intely.locale")).toBe("hu"));
    expect(screen.queryByRole("note")).toBeNull(); // hu is reviewed
    fireEvent.input(screen.getByLabelText("Nyelv keresése"), { target: { value: "deu" } });
    fireEvent.click(within(screen.getByRole("listbox", { name: "Nyelv" })).getByRole("option"));
    await waitFor(() => expect(localStorage.getItem("intely.locale")).toBe("de"));
    expect(await screen.findByRole("note")).toBeTruthy(); // de is machine translated
    await setLocale("en");
  });

  it("keyboard: arrow keys move through the matches and Enter picks", async () => {
    render(() => <GeneralSection />);
    const search = await screen.findByLabelText("Search languages");
    fireEvent.input(search, { target: { value: "port" } });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(["pt-BR", "pt-PT"]).toContain(localStorage.getItem("intely.locale")));
    await setLocale("en");
  });
});

describe("<AppearanceSection>", () => {
  it("applies density and font size at once and keeps the mirror", async () => {
    render(() => <AppearanceSection />);
    fireEvent.click(await screen.findByRole("radio", { name: "Compact" }));
    await waitFor(() => expect(document.documentElement.dataset.density).toBe("compact"));
    fireEvent.change(screen.getByLabelText("Interface font size"), { target: { value: "15" } });
    await waitFor(() => expect(document.documentElement.style.getPropertyValue("--text-base")).toBe("15px"));
    expect(JSON.parse(localStorage.getItem("intely.appearance")!)).toMatchObject({ density: "compact", uiFontSize: 15 });
  });

  it("offers the accent families as a radio grid, applies one at once and persists it", async () => {
    render(() => <AppearanceSection />);
    const group = await screen.findByRole("radiogroup", { name: "Accent" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.length).toBeGreaterThanOrEqual(12); // 11 families + custom
    expect(within(group).getByRole("radio", { name: /Violet/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(group).getByRole("radio", { name: "Teal" }));
    await waitFor(() => expect(document.documentElement.dataset.accent).toBe("teal"));
    expect(document.getElementById("intely-accent")?.textContent).toContain("--accent:");
    expect(JSON.parse(localStorage.getItem("intely.appearance")!)).toMatchObject({ accent: "teal" });
    expect(within(group).getByRole("radio", { name: "Teal" }).getAttribute("aria-checked")).toBe("true");
    // keyboard: roving selection, wraps around
    fireEvent.keyDown(group, { key: "ArrowRight" });
    await waitFor(() => expect(document.documentElement.dataset.accent).toBe("green"));
    fireEvent.keyDown(group, { key: "Home" });
    await waitFor(() => expect(document.documentElement.dataset.accent).toBe("violet"));
    expect(document.getElementById("intely-accent")).toBeNull();
  });

  it("custom colour: live preview, hex validation and AA adjustment note", async () => {
    render(() => <AppearanceSection />);
    fireEvent.click(await screen.findByRole("radio", { name: "Custom colour" }));
    const hex = await screen.findByLabelText("Hex colour");
    fireEvent.input(hex, { target: { value: "#ffff00" } });
    expect(document.documentElement.dataset.accent).toBe("custom"); // live, before the change event
    fireEvent.change(hex, { target: { value: "#ffff00" } });
    await waitFor(() => expect(JSON.parse(localStorage.getItem("intely.appearance")!)).toMatchObject({ accent: "custom", customAccent: "#ffff00" }));
    expect(await screen.findByText(/stays readable|Shown as/)).toBeTruthy();
    fireEvent.input(hex, { target: { value: "#12" } });
    expect((await screen.findByRole("alert")).textContent).toContain("six-digit");
  });
});

describe("<EditorSection>", () => {
  it("toggles and stores the editor settings, and marks format on save as a placeholder", async () => {
    render(() => <EditorSection />);
    const wrap = await screen.findByRole("switch", { name: "Soft wrap" });
    expect(wrap.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(wrap);
    await waitFor(() => expect(wrap.getAttribute("aria-checked")).toBe("true"));
    fireEvent.change(screen.getByLabelText("Tab size"), { target: { value: "2" } });
    await waitFor(() => expect((screen.getByLabelText("Tab size") as HTMLSelectElement).value).toBe("2"));
    expect(screen.queryByText(/Format on save/)).toBeNull();
  });
});

describe("<SafetySection>", () => {
  it("shows the engine's mode and guard lists read-only and edits live-branch patterns per repo", async () => {
    render(() => <SafetySection />);
    expect(await screen.findByText("Normal mode")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Never-add patterns" })).getByText("dump_*")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Secret patterns" })).getByText(".env")).toBeTruthy();

    const repo = repos()[0];
    const live = `Live branches of ${repo.name}`;
    fireEvent.input(screen.getByLabelText(`Add to ${live}`), { target: { value: "bad name" } });
    fireEvent.click(within(screen.getByLabelText(`Add to ${live}`).closest("form")!).getByRole("button", { name: "Add" }));
    expect((await screen.findByText(/no spaces/)).getAttribute("role")).toBe("alert");
    fireEvent.input(screen.getByLabelText(`Add to ${live}`), { target: { value: "staging" } });
    fireEvent.click(within(screen.getByLabelText(`Add to ${live}`).closest("form")!).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(workspace()!.liveBranches?.[repo.id]).toEqual(["staging"]));

    fireEvent.click(screen.getByRole("button", { name: `Remove staging from ${live}` }));
    await waitFor(() => expect(workspace()!.liveBranches?.[repo.id]).toBeUndefined());
  });
});

describe("<SafetySection> secret store", () => {
  it("says when the Keychain failed and asks it again on request", async () => {
    const { ipc } = await import("../../ipc");
    const status = vi.spyOn(ipc.secrets, "status").mockResolvedValueOnce({ backend: "memory", degraded: true, message: "The Keychain denied access." }).mockResolvedValue({ backend: "keychain", degraded: false, message: null });
    const retry = vi.spyOn(ipc.secrets, "retryKeychain").mockResolvedValue();
    render(() => <SafetySection />);
    expect(await screen.findByText("The Keychain denied access.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try the Keychain again" }));
    await waitFor(() => expect(retry).toHaveBeenCalled());
    expect(await screen.findByText("Tokens and keys are kept in the macOS Keychain.")).toBeTruthy();
    status.mockRestore();
    retry.mockRestore();
  });
});

describe("<KeyboardSection>", () => {
  it("lists shortcuts under their command group and highlights a conflict", async () => {
    registerCommand({ id: "a.one", title: "Alpha action", group: "Alpha", shortcut: "Cmd+Shift+9", run: () => {} });
    registerCommand({ id: "b.two", title: "Beta action", group: "Beta", run: () => {} });
    registerShortcut({ id: "b.two:dup", keys: "Cmd+Shift+9", command: "b.two" });
    expect(allCommands()).toHaveLength(2);
    render(() => <KeyboardSection />);
    const alpha = await screen.findByRole("list", { name: "Alpha shortcuts" });
    expect(within(alpha).getByText("Alpha action")).toBeTruthy();
    expect(within(alpha).getByText("Conflict")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("conflicting");
  });
});

describe("<AboutSection>", () => {
  it("shows the lockup, the versions and a doctor report", async () => {
    render(() => <AboutSection />);
    expect(await screen.findByRole("img", { name: "IntelyIDE" })).toBeTruthy();
    expect(screen.getByText("This build")).toBeTruthy();
    expect(screen.getByText("Ferenc Farkas")).toBeTruthy();
    expect(screen.getByRole("button", { name: /ferencfarkas09/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /IntelyHome/ })).toBeTruthy();
    const report = await screen.findByRole("list", { name: "Doctor report" });
    await waitFor(() => expect(within(report).getAllByRole("listitem").length).toBeGreaterThan(0));
  });
});
