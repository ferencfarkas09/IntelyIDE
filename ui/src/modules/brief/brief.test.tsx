import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async () => ({ ipc: (await import("../../store/testing-u2")).normal.ipc }));
vi.mock("../../store/selection", async () => (await import("../../store/testing-u2")).selectionModule);
vi.mock("../../store/snapshots", async () => (await import("../../store/testing-u2")).snapshotsModule);
vi.mock("../../store/workspace", async () => (await import("../../store/testing-u2")).workspaceModule);

import { ipc } from "../../ipc";
import { availableCommands, resetCommands } from "../../platform/commands";
import { resetSettings, settingsSections } from "../../platform/settings";
import { resetTabs, tabTypes } from "../../platform/tabs";
import { startAgentStore } from "../../store/agents";
import { installDomStubs, normal, seedStores } from "../../store/testing-u2";
import { createMockNight, FIXTURE_RUNS, fixtureBrief, setNightApi } from "./api";
import { register } from "./index";
import NightTab from "./NightTab";
import { resetNight } from "./store";
import { setNightQueueEnabled } from "./toggle";

installDomStubs();

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  localStorage.clear();
  normal.reset();
  resetNight();
  await seedStores(ipc, {});
  startAgentStore(ipc);
});
afterEach(() => {
  cleanup();
  setNightApi(undefined);
});

const draft = { roleId: "developer", repoIds: ["backend"], prompt: "Do the thing", maxMinutes: 5, maxTokens: 50_000 };

describe("mock night queue (the same rules as the Rust state machine)", () => {
  it("refuses beyond the cap of runs per night and refuses bad drafts with a code", async () => {
    const api = createMockNight();
    for (let i = 0; i < 8; i++) await api.add(draft);
    await expect(api.add(draft)).rejects.toMatchObject({ code: "nightCap" });
    const fresh = createMockNight();
    await expect(fresh.add({ ...draft, prompt: " " })).rejects.toMatchObject({ code: "emptyPrompt" });
    await expect(fresh.add({ ...draft, maxMinutes: 0 })).rejects.toMatchObject({ code: "badBudget" });
  });

  it("runs the items one at a time, in order", async () => {
    const api = createMockNight({ runMs: 15 });
    await api.add(draft);
    await api.add({ ...draft, prompt: "second" });
    const seen: string[][] = [];
    api.onState((v) => seen.push(v.items.map((i) => i.state)));
    await api.arm(true);
    await tick(80);
    expect(seen.every((states) => states.filter((s) => s === "running").length <= 1)).toBe(true);
    const end = (await api.state()).items.map((i) => i.state);
    expect(end).toEqual(["done", "failed"].slice(0, 2).map((s, i) => (i === 0 ? "done" : s)));
  });

  it("does not start while on battery or read-only", async () => {
    for (const opts of [{ battery: true }, { readOnly: true }]) {
      const api = createMockNight({ ...opts, runMs: 10 });
      await api.add(draft);
      const v = await api.arm(true);
      await tick(40);
      expect(v.paused).toBe(opts.battery ? "battery" : "readOnly");
      expect((await api.state()).items[0].state).toBe("queued");
    }
  });

  it("cancels the rest and clears the finished ones", async () => {
    const api = createMockNight({ runMs: 10_000 });
    await api.add(draft);
    await api.add(draft);
    await api.arm(true);
    await expect(api.remove("n-1")).rejects.toMatchObject({ code: "itemRunning" });
    const v = await api.arm(false, true);
    expect(v.items.map((i) => i.state)).toEqual(["running", "skipped"]);
    await api.stop();
    expect((await api.state()).items[0]).toMatchObject({ state: "stopped", reason: "userStop" });
    expect((await api.clear()).items).toEqual([]);
  });

  it("builds the brief of the runs of the plan", async () => {
    const b = fixtureBrief(["night-run-2"]);
    expect(b.runs).toHaveLength(1);
    expect(b.totals).toMatchObject({ runs: 1, failed: 1, files: 5, additions: 120, deletions: 31, costUsd: 1.62 });
    expect(fixtureBrief().totals.runs).toBe(FIXTURE_RUNS.length);
    expect(fixtureBrief().totals.needsYou).toBe(2);
    expect(fixtureBrief().runs.find((r) => r.costUsd === undefined)?.runId).toBe("night-run-3");
  });
});

describe("night module toggle", () => {
  beforeAll(() => {
    resetSettings();
    resetTabs();
    resetCommands();
    register();
  });
  it("registers only the Settings section while off; the tab and the commands when on", () => {
    expect(settingsSections().map((s) => s.id)).toContain("night");
    expect(tabTypes().map((t) => t.type)).not.toContain("nightqueue");
    setNightQueueEnabled(true);
    expect(tabTypes().map((t) => t.type)).toContain("nightqueue");
    expect(availableCommands().map((c) => c.id)).toEqual(expect.arrayContaining(["night.queue", "night.brief"]));
    setNightQueueEnabled(false);
    expect(tabTypes().map((t) => t.type)).not.toContain("nightqueue");
    expect(availableCommands().map((c) => c.id)).not.toContain("night.queue");
  });
});

describe("<NightTab>", () => {
  it("shows the empty queue, adds a run through the form and offers to start the night", async () => {
    setNightApi(createMockNight({ runMs: 10_000 }));
    render(() => <NightTab />);
    await screen.findByText("Nothing prepared yet");
    expect((screen.getByRole("button", { name: "Start the night" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Add a run" }));
    const submit = (await screen.findByRole("button", { name: "Add to the queue" })) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: (screen.getByLabelText("Role") as HTMLSelectElement).options[1]?.value } });
    fireEvent.click(document.querySelector('.nq__repos input[type="checkbox"]') as HTMLInputElement);
    fireEvent.input(screen.getByLabelText("Prompt"), { target: { value: "Tidy the order service" } });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(document.querySelectorAll(".nq__item").length).toBe(1));
    expect(screen.getByText("Tidy the order service")).toBeTruthy();
    expect(screen.getByText("1 of 8 runs prepared")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Start the night" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("explains why the queue is paused", async () => {
    setNightApi(createMockNight({ battery: true }));
    render(() => <NightTab />);
    await screen.findByText(/on battery/);
    cleanup();
    resetNight();
    setNightApi(createMockNight({ readOnly: true }));
    render(() => <NightTab />);
    await screen.findByText(/read-only/);
  });

  it("shows the Morning brief: needs-you and failures first, totals, files per repo and a way into each review", async () => {
    setNightApi(createMockNight({ morning: true }));
    render(() => <NightTab />);
    fireEvent.click(await screen.findByRole("radio", { name: "Morning brief" }));
    await waitFor(() => expect(document.querySelectorAll(".bf__run").length).toBe(4));
    const titles = [...document.querySelectorAll(".bf__title")].map((e) => e.textContent);
    expect(titles[0]).toBe("Migrate the mobile app to the new auth flow");
    expect(titles.indexOf("Update the dependency audit notes")).toBeLessThan(titles.indexOf("Fix the delivery fee rounding in checkout"));
    const totals = document.querySelector(".bf__totals")!.textContent!;
    expect(totals).toContain("$2.06");
    expect(document.querySelector('[data-run="night-run-3"]')!.textContent).toContain("Bash: npm audit fix");
    expect(document.querySelector('[data-run="night-run-3"]')!.textContent).toContain("n/a");
    expect(document.querySelectorAll('[data-run="night-run-1"] .bf__repohead')[0].textContent).toContain("3 files");
    expect(screen.getAllByRole("button", { name: "Open review" })).toHaveLength(4);
  });

  it("calls the model only when the summary button is clicked", async () => {
    const api = createMockNight({ morning: true });
    const summarise = vi.fn(api.summarise);
    setNightApi({ ...api, summarise });
    render(() => <NightTab />);
    fireEvent.click(await screen.findByRole("radio", { name: "Morning brief" }));
    await waitFor(() => expect(document.querySelectorAll(".bf__run").length).toBe(4));
    expect(summarise).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Summarise with Haiku" }));
    await screen.findByText(/Four runs worked overnight/);
    expect(summarise).toHaveBeenCalledTimes(1);
  });
});
