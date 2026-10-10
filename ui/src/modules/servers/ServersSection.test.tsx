import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async (orig) => {
  const mod = await orig<typeof import("../../ipc")>();
  const { createMockIpc } = await import("../../ipc/mock");
  return { ...mod, ipc: createMockIpc("normal", { delayScale: 0 }) };
});

import { ipc } from "../../ipc";
import { createMockServers, type MockServersHandle } from "../../ipc/mock/servers";
import { resetSettings, settingsSections } from "../../platform/settings";
import { installDomStubs } from "../../store/testing-u2";
import { loadWorkspace, repos } from "../../store/workspace";
import { toast } from "../../ui-kit";
import { register } from "./index";
import { LocationChip } from "./LocationChip";
import ServersSection from "./ServersSection";
import { resetServers } from "./store";

installDomStubs();
vi.setConfig({ testTimeout: 30000 });

let mock: MockServersHandle;
const install = (m: MockServersHandle | typeof mock) => {
  mock = m as MockServersHandle;
  (ipc as { servers: unknown }).servers = m;
};
beforeEach(() => {
  resetServers();
  install(createMockServers({ stepMs: 0 }));
});
afterEach(() => {
  cleanup();
  resetSettings();
  vi.restoreAllMocks();
});

const card = (name: string) => within(screen.getByRole("listitem", { name }));
const open = async () => {
  render(() => <ServersSection />);
  await screen.findByRole("listitem", { name: "Build server" });
};

describe("register()", () => {
  it("adds the Servers section at order 47 and calls no IPC", () => {
    const calls = [vi.spyOn(ipc.servers, "list"), vi.spyOn(ipc.servers, "probe"), vi.spyOn(ipc.servers, "onStatus")];
    register();
    expect(settingsSections().find((s) => s.id === "servers")).toMatchObject({ order: 47 });
    for (const c of calls) expect(c).not.toHaveBeenCalled();
  });
});

describe("the list", () => {
  it("shows each server with its status chip, destination, platform, capacity and checklist", async () => {
    await open();
    const build = card("Build server");
    expect(build.getByText("Ready")).toBeTruthy();
    expect(build.getByText("build1")).toBeTruthy();
    expect(build.getByText("linux x64")).toBeTruthy();
    expect(build.getByText("Running 1 of 6")).toBeTruthy();
    const checks = within(build.getByRole("list", { name: "What is installed on the server" }));
    expect(checks.getAllByRole("listitem")).toHaveLength(5);
    expect(checks.getByText("v24.13.0")).toBeTruthy();
    expect(card("GPU box").getByText("Needs setup")).toBeTruthy();
    expect(card("GPU box").getByText("dev@gpu.example.com:2222")).toBeTruthy();
    expect(card("Old box").getByText("Unreachable")).toBeTruthy();
    expect(card("Old box").getByText("Host key verification failed.")).toBeTruthy();
    expect(card("Old box").getByText(/Connect once from a terminal/)).toBeTruthy();
  });

  it("explains that the IDE uses the person's ssh keys and never accepts an unknown host key", async () => {
    await open();
    expect(screen.getByText(/never asks for a password and never accepts an unknown host key/)).toBeTruthy();
  });

  it("shows an empty state when there is no server", async () => {
    install(createMockServers({ stepMs: 0, seed: false }));
    render(() => <ServersSection />);
    expect(await screen.findByText(/No servers yet/)).toBeTruthy();
  });

  it("tells how to sign in when Claude is installed but not signed in", async () => {
    await open();
    expect(card("Build server").queryByRole("note")).toBeNull();
    fireEvent.click(card("GPU box").getByRole("button", { name: "Set up" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    await waitFor(() => expect(card("GPU box").getByRole("note").textContent).toContain("ssh -t -p 2222 dev@gpu.example.com claude"));
  });
});

describe("Test connection", () => {
  it("fills in a server that was never checked", async () => {
    const real = createMockServers({ stepMs: 0 });
    install({ ...real, list: async () => (await real.list()).map((v) => (v.cfg.id === "gpu-box" ? { cfg: v.cfg, running: 0 } : v)) } as MockServersHandle);
    await open();
    expect(card("GPU box").getByText("Not checked")).toBeTruthy();
    fireEvent.click(card("GPU box").getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(card("GPU box").getByText("Needs setup")).toBeTruthy());
  });

  it("shows the reason when the call itself is rejected", async () => {
    await open();
    vi.spyOn(ipc.servers, "probe").mockRejectedValueOnce({ code: "io", message: "ssh binary not found" });
    fireEvent.click(card("Build server").getByRole("button", { name: "Test connection" }));
    expect((await card("Build server").findByRole("alert")).textContent).toBe("ssh binary not found");
  });
});

describe("Set up", () => {
  it("offers four choices, all on except what the server has, and sends them", async () => {
    await open();
    const spy = vi.spyOn(ipc.servers, "setup");
    fireEvent.click(card("Build server").getByRole("button", { name: "Update" }));
    const boxes = await screen.findAllByRole("checkbox");
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([false, false, false, false]);
    fireEvent.click(screen.getByRole("checkbox", { name: /Claude Code/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("build-server", { installNode: false, installBundle: false, installSdk: false, installClaude: true }));
  });

  it("shows the steps in the order they happen and a clear result, then the server is Ready", async () => {
    await open();
    fireEvent.click(card("GPU box").getByRole("button", { name: "Set up" }));
    expect((await screen.findAllByRole("checkbox")).every((b) => (b as HTMLInputElement).checked)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByText("Setup finished.");
    const steps = within(screen.getByRole("list", { name: "Setup steps" })).getAllByRole("listitem").filter((li) => li.hasAttribute("data-step"));
    expect(steps.map((s) => s.getAttribute("data-step"))).toEqual(["probe", "prepare", "node", "bundle", "sdk", "claude", "verify"]);
    expect(steps.every((s) => s.getAttribute("data-state") === "done")).toBe(true);
    expect(within(steps[2]).getByText("Downloading node-v24.13.0-linux-x64.tar.xz")).toBeTruthy();
    expect(card("GPU box").getByText("Ready")).toBeTruthy();
  });

  it("shows the failing step and its message prominently", async () => {
    await open();
    fireEvent.click(card("GPU box").getByRole("button", { name: "Set up" }));
    mock.failSetupAt("sdk");
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe('Setup stopped at "Agent SDK": Installing the Agent SDK failed: the command exited with status 1.');
    expect(screen.queryByText("Setup finished.")).toBeNull();
    expect(document.querySelector('[data-step="sdk"]')?.getAttribute("data-state")).toBe("failed");
  });

  it("fails at the first step for an unreachable host and says why", async () => {
    await open();
    fireEvent.click(card("Old box").getByRole("button", { name: "Set up" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    expect((await screen.findByRole("alert")).textContent).toContain('"Connect": Host key verification failed.');
  });
});

describe("add, edit and delete", () => {
  const fill = (label: string, value: string) => fireEvent.input(screen.getByLabelText(label), { target: { value } });

  it("adds a server from the form with its defaults", async () => {
    await open();
    const save = vi.spyOn(ipc.servers, "save");
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect((dialog.getByLabelText("Repository folder on the server") as HTMLInputElement).value).toBe("~/work");
    expect((dialog.getByLabelText("Max agents") as HTMLInputElement).value).toBe("4");
    expect(dialog.getByText("A host from your ~/.ssh/config, or user@host.")).toBeTruthy();
    fill("Name", "Test box");
    fill("SSH destination", "dev@test.example");
    fireEvent.click(dialog.getByRole("button", { name: "Add server" }));
    await screen.findByRole("listitem", { name: "Test box" });
    expect(save).toHaveBeenCalledWith({ name: "Test box", destination: "dev@test.example", root: "~/work", maxAgents: 4, enabled: true });
    expect(card("Test box").getByText("Not checked")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("checks the form before saving and shows one message under each field", async () => {
    await open();
    const save = vi.spyOn(ipc.servers, "save");
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    const dialog = within(await screen.findByRole("dialog"));
    fill("Max agents", "99");
    fill("Port", "70000");
    fireEvent.click(dialog.getByRole("button", { name: "Add server" }));
    expect(await dialog.findByText("Give the server a name.")).toBeTruthy();
    expect(dialog.getByText("Enter the SSH destination.")).toBeTruthy();
    expect(dialog.getByText("The port must be a number from 1 to 65535.")).toBeTruthy();
    expect(dialog.getByText("Max agents must be a whole number from 1 to 64.")).toBeTruthy();
    expect(dialog.getByLabelText("Name").getAttribute("aria-invalid")).toBe("true");
    expect(save).not.toHaveBeenCalled();
  });

  it("shows the backend's own message under the field it names, and a general one at the bottom", async () => {
    await open();
    const save = vi.spyOn(ipc.servers, "save").mockRejectedValueOnce({ code: "invalidDestination", message: "Backend: unknown host format." }).mockRejectedValueOnce({ code: "io", message: "Could not write the settings file." });
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    const dialog = within(await screen.findByRole("dialog"));
    fill("Name", "Another");
    fill("SSH destination", "x1");
    fireEvent.click(dialog.getByRole("button", { name: "Add server" }));
    expect((await dialog.findByText("Backend: unknown host format.")).getAttribute("role")).toBe("alert");
    fireEvent.click(dialog.getByRole("button", { name: "Add server" }));
    expect(await dialog.findByText("Could not write the settings file.")).toBeTruthy();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("rejects a name another server has", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    const dialog = within(await screen.findByRole("dialog"));
    fill("Name", "gpu BOX");
    fill("SSH destination", "x1");
    fireEvent.click(dialog.getByRole("button", { name: "Add server" }));
    expect(await dialog.findByText("Another server already has this name.")).toBeTruthy();
  });

  it("edits a server and keeps its id", async () => {
    await open();
    const save = vi.spyOn(ipc.servers, "save");
    fireEvent.click(card("GPU box").getByRole("button", { name: "Edit" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect((dialog.getByLabelText("Port") as HTMLInputElement).value).toBe("2222");
    fill("Name", "GPU box 2");
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await screen.findByRole("listitem", { name: "GPU box 2" });
    expect(save.mock.calls[0][0]).toMatchObject({ id: "gpu-box", name: "GPU box 2", port: 2222 });
  });

  it("deletes after a confirmation, and Cancel keeps the server", async () => {
    await open();
    fireEvent.click(card("Old box").getByRole("button", { name: "Delete" }));
    let dialog = within(await screen.findByRole("alertdialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("listitem", { name: "Old box" })).toBeTruthy();
    fireEvent.click(card("Old box").getByRole("button", { name: "Delete" }));
    dialog = within(await screen.findByRole("alertdialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "Old box" })).toBeNull());
  });

  it("explains why a server with live runs cannot be deleted", async () => {
    await open();
    fireEvent.click(card("Build server").getByRole("button", { name: "Delete" }));
    const dialog = within(await screen.findByRole("alertdialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Delete" }));
    expect((await dialog.findByRole("alert")).textContent).toBe("1 run is live on this server. Stop them first.");
    expect(screen.getByRole("listitem", { name: "Build server" })).toBeTruthy();
  });
});

describe("Repositories and Clone missing", () => {
  it("lists the workspace repositories and clones the missing ones, then refreshes", async () => {
    await loadWorkspace();
    const ids = repos().map((r) => r.id);
    expect(ids.length).toBeGreaterThan(0);
    await open();
    const clone = vi.spyOn(ipc.servers, "clone");
    fireEvent.click(card("GPU box").getByRole("button", { name: "Repositories" }));
    const panel = within(await screen.findByRole("region", { name: "Repositories on GPU box" }));
    await waitFor(() => expect(panel.getAllByText("not cloned")).toHaveLength(ids.length));
    fireEvent.click(panel.getByRole("button", { name: "Clone missing" }));
    await waitFor(() => expect(clone).toHaveBeenCalledTimes(ids.length));
    expect(clone.mock.calls.map((c) => c[1])).toEqual(ids);
    await waitFor(() => expect(panel.queryAllByText("not cloned")).toHaveLength(0));
    expect((panel.getByRole("button", { name: "Clone missing" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("reports the repositories that could not be cloned in one toast and still refreshes", async () => {
    await loadWorkspace();
    const first = repos()[0].id;
    await open();
    const error = vi.spyOn(toast, "error");
    vi.spyOn(ipc.servers, "clone").mockImplementation(async (_, id) => {
      if (id === first) throw { code: "git", message: "Permission denied (publickey)." };
    });
    fireEvent.click(card("GPU box").getByRole("button", { name: "Repositories" }));
    const panel = within(await screen.findByRole("region", { name: "Repositories on GPU box" }));
    await waitFor(() => expect(panel.getAllByText("not cloned").length).toBeGreaterThan(0));
    fireEvent.click(panel.getByRole("button", { name: "Clone missing" }));
    await waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(error.mock.calls[0][1]).toContain("Permission denied (publickey).");
  });
});

describe("Copy SSH command", () => {
  it("puts the command on the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await open();
    fireEvent.click(card("GPU box").getByRole("button", { name: "Copy SSH command" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("ssh -p 2222 dev@gpu.example.com"));
  });
});

describe("the location chip", () => {
  it("shows the server's name, read once for all rows", async () => {
    const list = vi.spyOn(ipc.servers, "list");
    render(() => (
      <>
        <LocationChip id="gpu-box" />
        <LocationChip id="gpu-box" />
        <LocationChip id="gone" />
      </>
    ));
    await waitFor(() => expect(screen.getAllByText("GPU box")).toHaveLength(2));
    expect(screen.getByText("gone")).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(1);
  });
});
