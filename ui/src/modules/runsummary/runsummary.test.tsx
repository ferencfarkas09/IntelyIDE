import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async () => ({ ipc: (await import("../../store/testing-u2")).normal.ipc }));
vi.mock("../../platform/newRun", () => ({ requestNewRun: vi.fn(async () => true) }));

import { requestNewRun } from "../../platform/newRun";
import { allCommands, availableCommands, resetCommands } from "../../platform/commands";
import { resetRunSlots, runSlots } from "../../platform/runSlots";
import { resetSettings, settingsSections } from "../../platform/settings";
import type { AgentRow } from "../../store/agents";
import { installDomStubs } from "../../store/testing-u2";
import { createMockRunSummary, fixtureDigest, setRunSummaryApi } from "./api";
import { register } from "./index";
import RunSummaryCard from "./RunSummaryCard";
import RunSummaryChip from "./RunSummaryChip";
import { requestShow, resetRunSummary } from "./store";
import { setRunSummaryEnabled } from "./toggle";
import type { RunDigest } from "./types";

installDomStubs();

const row = (status: AgentRow["status"], agentId = "a-1"): AgentRow => ({ agentId, status, repoIds: ["storefront"], title: "Map", needs: 0 }) as unknown as AgentRow;

beforeEach(() => {
  localStorage.clear();
  resetRunSummary();
  vi.mocked(requestNewRun).mockClear();
});
afterEach(() => {
  cleanup();
  setRunSummaryApi(undefined);
});

describe("the card", () => {
  it("shows the bullets, what to check with the dev script, and the risks of a finished run", async () => {
    setRunSummaryApi(createMockRunSummary({ scripts: { storefront: [{ group: "dev", runner: "pnpm dev" }] } }));
    render(() => <RunSummaryCard agent={row("done")} />);
    expect(await screen.findByText("What this run did")).toBeTruthy();
    expect(screen.getByText("Changed 4 screen files, 2 settings files, 1 style file, and 2 more files.")).toBeTruthy();
    expect(screen.getByText("9 files · 3 risks").getAttribute("data-tone")).toBe("warn");
    expect(await screen.findByText("Start the app with pnpm dev and look at the changed screens.")).toBeTruthy();
    expect(screen.getByText("Risks")).toBeTruthy();
    expect(screen.getByText("Added 1 new package: react-native-maps.")).toBeTruthy();
    expect(screen.getByText("Installed 1 new package from the internet: react-native-maps.")).toBeTruthy();
  });

  it("collapses and remembers it", async () => {
    render(() => <RunSummaryCard agent={row("done")} />);
    const toggle = (await screen.findByText("What this run did")).closest("button")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("What to check")).toBeNull();
    expect(localStorage.getItem("intely.runSummary.collapsed")).toBe("1");
  });

  it("is not fetched while the run works, and fetched again when its status changes", async () => {
    const calls: string[] = [];
    setRunSummaryApi(createMockRunSummary({ digest: (id) => (calls.push(id), fixtureDigest(id)) }));
    const [status, setStatus] = createSignal<AgentRow["status"]>("running");
    render(() => <RunSummaryCard agent={row(status())} />);
    await Promise.resolve();
    expect(calls).toEqual([]);
    expect(screen.queryByText("What this run did")).toBeNull();
    setStatus("done");
    expect(await screen.findByText("What this run did")).toBeTruthy();
    setStatus("running");
    await waitFor(() => expect(screen.queryByText("What this run did")).toBeNull());
    setStatus("error");
    await waitFor(() => expect(calls).toEqual(["a-1", "a-1"]));
  });

  it("renders nothing for a run without a log", async () => {
    const calls: string[] = [];
    setRunSummaryApi(createMockRunSummary({ digest: (id) => (calls.push(id), null) }));
    const { container } = render(() => <RunSummaryCard agent={row("done")} />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(container.textContent).toBe("");
  });

  it("Explain in plain words only prefills a New run with the masked facts", async () => {
    const secretish: RunDigest = { ...fixtureDigest("a-1"), commands: [{ text: "GITHUB_TOKEN=*** npm publish", failed: false }], decisions: [{ kind: "final", text: "Published.", done: false }] };
    setRunSummaryApi(createMockRunSummary({ digest: () => secretish }));
    render(() => <RunSummaryCard agent={row("done")} />);
    fireEvent.click(await screen.findByText("Explain in plain words"));
    await waitFor(() => expect(requestNewRun).toHaveBeenCalledTimes(1));
    const arg = vi.mocked(requestNewRun).mock.calls[0][0];
    expect(arg.repoIds).toEqual(["storefront"]);
    expect(arg.prompt).toContain("GITHUB_TOKEN=*** npm publish");
    expect(arg.prompt).toContain("Do not run tools");
    expect(arg.prompt).not.toMatch(/ghp_|sk-/);
    // only facts of the digest: no transcript, no file contents
    const allowed = new Set(arg.prompt.split("\n"));
    expect([...allowed].some((l) => l.startsWith("Task title: Show the store's location on a map"))).toBe(true);
  });

  it("opens and expands when the palette asks for it", async () => {
    localStorage.setItem("intely.runSummary.collapsed", "1");
    render(() => <RunSummaryCard agent={row("done")} />);
    const toggle = (await screen.findByText("What this run did")).closest("button")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    requestShow("a-1");
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"));
  });
});

describe("the chip", () => {
  it("is plain text with a warn tone when there are risks", async () => {
    const { container } = render(() => <RunSummaryChip agent={row("done")} />);
    const chip = await screen.findByText("9 files · 3 risks");
    expect(chip.getAttribute("data-tone")).toBe("warn");
    expect(container.querySelector("button, a, input, [tabindex]")).toBeNull();
  });

  it("is neutral without risks and absent while the run works", async () => {
    setRunSummaryApi(createMockRunSummary({ digest: (id) => ({ ...fixtureDigest(id), risks: [], fileCount: 1 }) }));
    const { container } = render(() => <RunSummaryChip agent={row("running", "a-2")} />);
    await Promise.resolve();
    expect(container.textContent).toBe("");
    cleanup();
    render(() => <RunSummaryChip agent={row("done", "a-3")} />);
    expect((await screen.findByText("1 file")).getAttribute("data-tone")).toBe("neutral");
  });
});

describe("registration", () => {
  afterEach(() => {
    setRunSummaryEnabled(true);
    resetCommands();
    resetSettings();
    resetRunSlots();
  });

  it("adds the slots and the command while on, and only the Settings section while off", async () => {
    register();
    expect(settingsSections().some((s) => s.id === "runsummary")).toBe(true);
    expect(runSlots("top").map((s) => s.id)).toContain("runsummary.card");
    expect(runSlots("card").map((s) => s.id)).toContain("runsummary.chip");
    expect(allCommands().some((c) => c.id === "runsummary.show")).toBe(true);
    expect(availableCommands().some((c) => c.id === "runsummary.show")).toBe(false); // no finished run selected
    setRunSummaryEnabled(false);
    await waitFor(() => expect(runSlots("top").map((s) => s.id)).not.toContain("runsummary.card"));
    expect(runSlots("card").map((s) => s.id)).not.toContain("runsummary.chip");
    expect(allCommands().some((c) => c.id === "runsummary.show")).toBe(false);
  });
});
