import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import { registerCommand, resetCommands } from "../../platform/commands";
import { newRunPrefill } from "../../platform/newRun";
import { installDomStubs } from "../../store/testing-u2";
import { importRequested, clearImportRequest } from "../mcp/importRequest";
import { setDeepPatternApi, type DeepPatternApi } from "./api";
import DeepPatternIntegration from "./DeepPatternIntegration";
import { resetDeepPattern } from "./store";
import type { DpReport, DpStatus } from "./types";

installDomStubs();

const openTerminal = vi.hoisted(() => vi.fn(async () => "term-1"));
vi.mock("../terminal/store", () => ({ openTerminal }));

const COMMANDS = {
  install: "git clone https://github.com/deeppatternai/decision-engine ~/decision-engine && cd ~/decision-engine && bash ./dp-install.sh",
  activate: "cd '/Users/me/.deeppattern/decision-engine' && python3 -m installer.permanent_setup",
  doctor: "bash '/Users/me/.deeppattern/decision-engine/dp-doctor.sh'",
};
const status = (over: Partial<DpStatus> = {}): DpStatus => ({ installed: true, activated: true, endpointHost: "de.example.com", recoveryRequired: false, root: "/Users/me/.deeppattern/decision-engine", doctor: true, commands: COMMANDS, ...over });
const WARN: DpReport = {
  verdict: "warn",
  exitCode: 0,
  tookMs: 900,
  lines: [
    { tone: "ok", text: "PASS Python 3.12" },
    { tone: "warn", text: "WARN LibreOffice not found" },
  ],
};

function rig(st: DpStatus, over: Partial<DeepPatternApi> = {}) {
  const calls = { doctor: 0, opened: [] as string[] };
  setDeepPatternApi({
    status: async () => st,
    doctor: async () => (calls.doctor++, WARN),
    openExternal: async (url) => void calls.opened.push(url),
    ...over,
  });
  return calls;
}

beforeEach(() => {
  resetDeepPattern();
  openTerminal.mockClear();
  clearImportRequest();
});
afterEach(() => {
  cleanup();
  resetCommands();
  setDeepPatternApi(undefined);
  vi.restoreAllMocks();
});

describe("<DeepPatternIntegration>", () => {
  it("shows an engine that is not installed: the install command, no check to run", async () => {
    rig(status({ installed: false, activated: false, doctor: false }));
    render(() => <DeepPatternIntegration />);
    expect(await screen.findByText("DeepPattern is not installed on this computer.")).toBeTruthy();
    expect(screen.getByText(COMMANDS.install)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Check" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says where an activated engine is connected and marks both steps done", async () => {
    rig(status());
    render(() => <DeepPatternIntegration />);
    expect(await screen.findByText("Activated, connected to de.example.com.")).toBeTruthy();
    expect(screen.getAllByText("Done")).toHaveLength(2);
    expect(screen.getByText("Installed in /Users/me/.deeppattern/decision-engine")).toBeTruthy();
  });

  it("runs the engine's check and shows its lines with the verdict", async () => {
    const calls = rig(status());
    render(() => <DeepPatternIntegration />);
    fireEvent.click(await screen.findByRole("button", { name: "Check" }));
    expect(await screen.findByText("Works, with warnings")).toBeTruthy();
    expect(calls.doctor).toBe(1);
    const warn = screen.getByText("WARN LibreOffice not found");
    expect(warn.getAttribute("data-tone")).toBe("warn");
    expect(screen.getByText("PASS Python 3.12").getAttribute("data-tone")).toBe("ok");
  });

  it("tells why a check could not run", async () => {
    rig(status(), { doctor: async () => Promise.reject({ code: "notInstalled", message: "x" }) });
    render(() => <DeepPatternIntegration />);
    fireEvent.click(await screen.findByRole("button", { name: "Check" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Install DeepPattern first.");
    expect(screen.queryByText("Works, with warnings")).toBeNull();
  });

  it("types a command into a new terminal and copies it on request", async () => {
    rig(status({ activated: false }));
    const write = vi.spyOn(ipc.term, "write").mockResolvedValue(undefined);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(() => <DeepPatternIntegration />);
    await screen.findByText(COMMANDS.activate);
    const box = screen.getByText(COMMANDS.activate).closest(".dp-cmd") as HTMLElement;
    fireEvent.click(within(box).getByRole("button", { name: "Run in terminal" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith("term-1", `${COMMANDS.activate}\n`));
    fireEvent.click(within(box).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(COMMANDS.activate));
  });

  it("opens the project page through the app", async () => {
    const calls = rig(status());
    render(() => <DeepPatternIntegration />);
    fireEvent.click(await screen.findByRole("button", { name: "Open the project page" }));
    expect(calls.opened).toEqual(["https://github.com/deeppatternai/decision-engine"]);
  });

  it("asks the MCP section for its import dialog and does not claim DeepPattern is added", async () => {
    rig(status());
    render(() => <DeepPatternIntegration />);
    expect(await screen.findByText("Not among the MCP servers yet.")).toBeTruthy();
    expect(screen.getByText(/Add DeepPattern to your agents and switch it on/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import from Claude Code…" }));
    expect(importRequested()).toBe(true);
  });

  it("opens the New run window with the audit prompt, which only reads", async () => {
    rig(status());
    registerCommand({ id: "runs.new", title: "New run", group: "Agents", run: () => {} });
    render(() => <DeepPatternIntegration />);
    fireEvent.click(await screen.findByRole("button", { name: "Audit my changes…" }));
    await waitFor(() => expect(newRunPrefill()?.prompt).toContain("DeepPattern Decision Engine tools"));
    expect(newRunPrefill()?.prompt).toMatch(/Do not edit, stage or commit anything/);
  });
});
