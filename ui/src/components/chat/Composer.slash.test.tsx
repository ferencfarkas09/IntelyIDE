import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSettings, settingsOpen } from "../../platform/settings";
import { agentDraft, resetAgents } from "../../store/agents";
import { chipRequest, resetChipRequests } from "../../store/chatCommands";
import { installDomStubs } from "../../store/testing-u2";
import { Composer, type ComposerProps } from "./Composer";

// The run the composer belongs to: it has MCP servers and a switchable mode unless a test says otherwise.
let run: { mcpServers?: unknown[]; switchableModes?: string[] } | undefined;
vi.mock("../../store/agents", async (orig) => ({ ...(await orig<typeof import("../../store/agents")>()), agentRow: () => run }));

installDomStubs();
beforeEach(() => {
  resetAgents();
  resetChipRequests();
  closeSettings();
  run = { mcpServers: [{ name: "github", status: "connected" }], switchableModes: ["readOnly", "ask"] };
});
afterEach(cleanup);

const CLI = ["compact", "context", "cost", "review", "init", "mcp"];
const field = () => screen.getByLabelText("Message to the agent") as HTMLTextAreaElement;
const props = (over: Partial<ComposerProps> = {}): ComposerProps => ({ agentId: "a1", repoIds: ["admin"], running: false, stopping: false, slashCommands: CLI, onSend: vi.fn(), onStop: vi.fn(), ...over });
const type = (text: string) => {
  field().value = text;
  field().setSelectionRange(text.length, text.length);
  fireEvent.input(field());
};
const names = () => screen.getAllByRole("option").map((o) => o.querySelector(".composer__cmd")?.textContent);

describe("<Composer> slash menu", () => {
  it("opens on a leading slash with the IDE commands first, then the CLI's own", () => {
    render(() => <Composer {...props()} />);
    expect(screen.queryByRole("listbox")).toBeNull();
    type("/");
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeTruthy();
    expect(names()).toEqual(["/mcp", "/agents", "/mode", "/compact", "/context", "/cost", "/review", "/init"]);
    expect(field().getAttribute("aria-expanded")).toBe("true");
  });

  it("filters while typing and closes with a space", () => {
    render(() => <Composer {...props()} />);
    type("/co");
    expect(names()).toEqual(["/compact", "/context", "/cost"]);
    type("/compact ");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field().getAttribute("aria-expanded")).toBe("false");
  });

  it("moves with the arrows (wrapping) and points aria-activedescendant at the active option", () => {
    render(() => <Composer {...props()} />);
    type("/co");
    const active = () => screen.getAllByRole("option").findIndex((o) => o.getAttribute("aria-selected") === "true");
    expect(active()).toBe(0);
    expect(field().getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[0].id);
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(active()).toBe(1);
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(active()).toBe(2);
    expect(field().getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[2].id);
  });

  it("closes with Escape and comes back when the text changes", () => {
    render(() => <Composer {...props()} />);
    type("/c");
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    type("/co");
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("completes a CLI command with Enter or Tab without sending it, then Cmd+Return sends it as the message", () => {
    const p = props();
    render(() => <Composer {...p} />);
    type("/comp");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(field().value).toBe("/compact ");
    expect(p.onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(field(), { key: "Enter", metaKey: true });
    expect(p.onSend).toHaveBeenCalledWith("/compact", []);
    type("/re");
    fireEvent.keyDown(field(), { key: "Tab" });
    expect(field().value).toBe("/review ");
  });

  it("takes the pointer pick of an option", () => {
    render(() => <Composer {...props()} />);
    type("/");
    fireEvent.pointerDown(screen.getAllByRole("option")[6]);
    expect(field().value).toBe("/review ");
  });

  it("/mcp + Enter opens the run's MCP popover and never sends", () => {
    const p = props();
    render(() => <Composer {...p} />);
    type("/mcp");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(p.onSend).not.toHaveBeenCalled();
    expect(chipRequest()).toMatchObject({ agentId: "a1", target: "mcp" });
    expect(agentDraft("a1")).toBe("");
    expect(settingsOpen()).toBe(false);
  });

  it("/mcp sent with Cmd+Return or with the menu dismissed is still the command, not a message", () => {
    const p = props();
    render(() => <Composer {...p} />);
    type("/mcp");
    fireEvent.keyDown(field(), { key: "Escape" });
    fireEvent.keyDown(field(), { key: "Enter", metaKey: true });
    expect(p.onSend).not.toHaveBeenCalled();
    expect(chipRequest()?.target).toBe("mcp");
    expect(agentDraft("a1")).toBe("");
  });

  it("/mcp opens Settings > MCP servers when the run has no MCP servers", () => {
    run = { mcpServers: [] };
    render(() => <Composer {...props()} />);
    type("/mcp");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(chipRequest()).toBeNull();
    expect(settingsOpen()).toBe(true);
  });

  it("/agents opens Settings and /mode asks for the mode menu of the run", () => {
    const p = props();
    render(() => <Composer {...p} />);
    type("/agents");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(settingsOpen()).toBe(true);
    type("/mode");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(chipRequest()).toMatchObject({ agentId: "a1", target: "mode" });
    expect(p.onSend).not.toHaveBeenCalled();
  });

  it("/mode says so when the run's mode cannot be changed", () => {
    run = { switchableModes: [] };
    render(() => <Composer {...props()} />);
    type("/mode");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(chipRequest()).toBeNull();
    expect(screen.getByText("This run's mode cannot be changed.")).toBeTruthy();
  });

  it("works while the run is busy: the IDE commands do not need the agent", () => {
    const p = props({ running: true });
    render(() => <Composer {...p} />);
    type("/mcp");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(chipRequest()?.target).toBe("mcp");
  });

  it("offers just the IDE commands before the CLI has reported its own", () => {
    render(() => <Composer {...props({ slashCommands: undefined })} />);
    type("/");
    expect(names()).toEqual(["/mcp", "/agents", "/mode"]);
  });
});
