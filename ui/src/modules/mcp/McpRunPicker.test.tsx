import type { PermissionMode } from "@intely/protocol";
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async (orig) => {
  const mod = await orig<typeof import("../../ipc")>();
  const { createMockIpc } = await import("../../ipc/mock");
  return { ...mod, ipc: createMockIpc("normal", { delayScale: 0 }) };
});

import { ipc } from "../../ipc";
import { createMockMcp } from "../../ipc/mock/mcp";
import type { McpRunServer } from "../../ipc/mcp";
import { resetSettings, settingsOpen } from "../../platform/settings";
import { installDomStubs } from "../../store/testing-u2";
import { McpRunPicker, mcpStartIds } from "./McpRunPicker";

configure({ asyncUtilTimeout: 15000 });
vi.setConfig({ testTimeout: 30000 });
installDomStubs();

beforeEach(() => {
  ipc.mcp = createMockMcp(ipc.settings, { delayMs: 0 });
});
afterEach(() => {
  cleanup();
  resetSettings();
  vi.restoreAllMocks();
});

const server = (over: Partial<McpRunServer> = {}): McpRunServer => ({
  id: "s1", name: "alpha", transport: "stdio", defaultOn: true, available: true, toolCount: 3, readOnlyCount: 1, defaultPolicy: "ask", hasDenied: false, hasSecretEnv: false, exposedCount: 0, ...over,
});

interface HarnessProps {
  provider?: string;
  mode?: PermissionMode;
  workspaceId?: string | null;
  initial?: string[];
  seen?: (ids: string[]) => void;
}

/** What the New run dialog does: the parent owns the selection and starts with []. */
function Harness(props: HarnessProps) {
  const [value, setValue] = createSignal<string[]>(props.initial ?? []);
  return (
    <>
      <McpRunPicker value={value()} onChange={(ids) => (setValue(ids), props.seen?.(ids))} provider={props.provider ?? "claude"} mode={props.mode ?? "ask"} workspaceId={props.workspaceId ?? null} />
      <output data-testid="value">{value().join(",")}</output>
    </>
  );
}
const selection = () => screen.getByTestId("value").textContent;
const chip = (name: string) => screen.getByRole("checkbox", { name: new RegExp(`^${name}\\b`) });
const useServers = (list: McpRunServer[]) => vi.spyOn(ipc.mcp, "runServers").mockResolvedValue(list);

describe("<McpRunPicker>", () => {
  it("renders nothing for a provider without MCP, and the parent sends no servers", async () => {
    const spy = vi.spyOn(ipc.mcp, "runServers");
    render(() => <Harness provider="codex" />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.queryByText("MCP servers")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(mcpStartIds(["a"], "codex")).toEqual([]);
  });

  it("is hidden until the first load resolves, then seeds the workspace default into the parent's empty selection", async () => {
    render(() => <Harness />);
    expect(screen.queryByRole("group", { name: "MCP servers for this run" })).toBeNull();
    const group = await screen.findByRole("group", { name: "MCP servers for this run" });
    // the seeded default: the servers that are on by default and can start (the fixture); docs and github need Settings first
    await waitFor(() => expect(chip("fixture").getAttribute("aria-checked")).toBe("true"));
    expect(selection()).toMatch(/^m0+1$/);
    expect(within(group).getAllByRole("checkbox")).toHaveLength(3);
    expect(screen.getByRole("group", { name: "MCP servers" }).querySelector("legend")!.textContent).toBe("MCP servers");
  });

  it("toggles a chip, and never reseeds after the first touch", async () => {
    render(() => <Harness />);
    await waitFor(() => expect(chip("fixture").getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(chip("fixture"));
    expect(selection()).toBe("");
    expect(chip("fixture").getAttribute("aria-checked")).toBe("false");
    // a change of the settings reloads the data; the workspace default is not put back
    await ipc.settings.set("mcp", { rev: 99 });
    await new Promise((r) => setTimeout(r, 30));
    expect(selection()).toBe("");
    fireEvent.click(chip("fixture"));
    expect(chip("fixture").getAttribute("aria-checked")).toBe("true");
  });

  it("follows the workspace override: a server switched off there is not preselected", async () => {
    const [fixture] = (await ipc.mcp.list()).servers;
    await ipc.mcp.workspaceSet("w-1", fixture.id, "off");
    render(() => <Harness workspaceId="w-1" />);
    await screen.findByRole("group", { name: "MCP servers for this run" });
    expect(selection()).toBe("");
    expect(chip("fixture").getAttribute("aria-checked")).toBe("false");
  });

  it("marks an unavailable chip aria-disabled, does not toggle it, and links to Settings for what Settings can fix", async () => {
    useServers([server({ id: "a", name: "alpha", defaultOn: false, available: false, unavailable: "needsConfirm" }), server({ id: "b", name: "beta", defaultOn: false, available: false, unavailable: "unsupportedAuth" }), server({ id: "c", name: "gamma", defaultOn: true })]);
    render(() => <Harness />);
    await screen.findByRole("group", { name: "MCP servers for this run" });
    for (const name of ["alpha", "beta"]) {
      expect(chip(name).getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(chip(name));
      expect(chip(name).getAttribute("aria-checked")).toBe("false");
    }
    expect(chip("gamma").hasAttribute("aria-disabled")).toBe(false);
    expect(selection()).toBe("c");
    // "Open settings" for needsConfirm, secretMissing and invalid only
    expect(screen.getAllByRole("button", { name: /^Open settings/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Open settings: alpha" }));
    expect(settingsOpen()).toBe(true);
  });

  it("drops a selected server that is no longer available once the user has touched a chip", async () => {
    const list = [server({ id: "a", name: "alpha" }), server({ id: "b", name: "beta" })];
    const spy = useServers(list);
    render(() => <Harness />);
    await waitFor(() => expect(selection()).toBe("a,b"));
    fireEvent.click(chip("beta"));
    fireEvent.click(chip("beta"));
    expect(selection()).toBe("a,b");
    spy.mockResolvedValue([server({ id: "a", name: "alpha" }), server({ id: "b", name: "beta", available: false, unavailable: "secretMissing" })]);
    await ipc.settings.set("mcp", { rev: 100 });
    await waitFor(() => expect(selection()).toBe("a"));
  });

  it("marks a server with a blocked tool", async () => {
    useServers([server({ hasDenied: true })]);
    render(() => <Harness />);
    expect(await screen.findByRole("img", { name: "Some tools are blocked" })).toBeTruthy();
  });

  it("shows the mode line under the chips only while a server is selected: Automatic, Bypass, Plan; none in Ask or Edit automatically", async () => {
    useServers([server()]);
    const cases: [PermissionMode, RegExp | null][] = [
      ["automatic", /Automatic runs call these servers' tools without asking/],
      ["bypass", /Bypass runs call these servers' tools without asking/],
      ["readOnly", /Plan only offers tools you set to Allow that the server marks read-only/],
      ["ask", null],
      ["edit", null],
    ];
    for (const [mode, text] of cases) {
      render(() => <Harness mode={mode} />);
      await waitFor(() => expect(chip("alpha").getAttribute("aria-checked")).toBe("true"));
      if (text) expect(screen.getByText(text)).toBeTruthy();
      else expect(screen.queryByText(/without asking|Plan only offers/)).toBeNull();
      cleanup();
    }
    // nothing selected, nothing said
    render(() => <Harness mode="automatic" />);
    await waitFor(() => expect(chip("alpha").getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(chip("alpha"));
    expect(screen.queryByText(/without asking/)).toBeNull();
  });

  it("warns about a secret environment in Automatic and Bypass for a server that has one, and not in Ask or for a header-only server", async () => {
    useServers([server({ id: "a", name: "github", hasSecretEnv: true }), server({ id: "b", name: "docs", transport: "http", hasSecretEnv: false })]);
    const secretLine = /github keep a secret in their environment/;
    for (const mode of ["automatic", "bypass"] as const) {
      render(() => <Harness mode={mode} />);
      await waitFor(() => expect(selection()).toBe("a,b"));
      expect(screen.getByText(secretLine)).toBeTruthy();
      expect(screen.queryByText(/docs keep a secret/)).toBeNull();
      cleanup();
    }
    render(() => <Harness mode="ask" />);
    await waitFor(() => expect(selection()).toBe("a,b"));
    expect(screen.queryByText(secretLine)).toBeNull();
    cleanup();
    // a selection without the secret-environment server has no such line either
    useServers([server({ id: "b", name: "docs", transport: "http" })]);
    render(() => <Harness mode="automatic" />);
    await waitFor(() => expect(selection()).toBe("b"));
    expect(screen.queryByText(secretLine)).toBeNull();
  });

  it("says how many changing tools would run unasked in Automatic and Bypass, from the exposure of the selected servers", async () => {
    useServers([server({ id: "a", name: "github", exposedCount: 2 }), server({ id: "b", name: "docs", exposedCount: 1 }), server({ id: "c", name: "quiet", defaultOn: false })]);
    render(() => <Harness mode="bypass" />);
    expect(await screen.findByText("3 tools of github, docs change things and would run without asking.")).toBeTruthy();
    fireEvent.click(chip("github"));
    expect(await screen.findByText("1 tool of docs change things and would run without asking.")).toBeTruthy();
    cleanup();
    render(() => <Harness mode="ask" />);
    await waitFor(() => expect(chip("github").getAttribute("aria-checked")).toBe("true"));
    expect(screen.queryByText(/would run without asking/)).toBeNull();
  });

  it("shows one muted line with a link to Settings when no server is configured", async () => {
    useServers([]);
    render(() => <Harness />);
    expect(await screen.findByText(/No MCP servers yet\./)).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));
    expect(settingsOpen()).toBe(true);
  });

  it("hides itself and logs once when the servers cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(ipc.mcp, "runServers").mockRejectedValue({ code: "io", message: "x" });
    render(() => <Harness />);
    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    await ipc.settings.set("mcp", { rev: 1 });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("group")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("reacts to a change of the settings: a new server appears as a chip", async () => {
    render(() => <Harness />);
    await screen.findByRole("group", { name: "MCP servers for this run" });
    const saved = await ipc.mcp.save({ name: "extra", transport: "stdio", command: "node", args: ["/a.js"], enabled: true });
    const view = (await ipc.mcp.list()).servers.find((s) => s.id === saved.id)!;
    await ipc.mcp.confirm(view.id, view.confirmHash);
    expect(await screen.findByRole("checkbox", { name: /^extra\b/ })).toBeTruthy();
  });

  it("is inert while disabled: it still seeds the default, but a click changes nothing", async () => {
    useServers([server()]);
    const onChange = vi.fn();
    render(() => <McpRunPicker value={[]} onChange={onChange} provider="claude" mode="ask" workspaceId={null} disabled />);
    const box = await screen.findByRole("checkbox", { name: /^alpha\b/ });
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith(["s1"]);
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(box.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("mcpStartIds", () => {
  it("returns the ids once for Claude and the mock provider, and nothing for any other provider", () => {
    expect(mcpStartIds(["a", "b", "a"], "claude")).toEqual(["a", "b"]);
    expect(mcpStartIds(["a"], "mock")).toEqual(["a"]);
    expect(mcpStartIds(["a"], "gemini")).toEqual([]);
    expect(mcpStartIds([], "claude")).toEqual([]);
  });
});
