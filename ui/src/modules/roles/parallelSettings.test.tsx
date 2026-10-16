import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import { installDomStubs } from "../../store/testing-u2";
import { DEFAULT_MAX_RUNS, MAX_MEMORY_MB, MAX_RUNS_RANGE, MIN_MEMORY_MB, ParallelSettings, validMaxRuns, validMemoryMb } from "./ParallelSettings";

installDomStubs();
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

const runs = () => screen.getByLabelText("Runs at once") as HTMLInputElement;
const memory = () => screen.getByLabelText("Memory for runs (MB)") as HTMLInputElement;
const shared = () => screen.getByRole("switch", { name: "Several runs may change the same repository at the same time" }) as HTMLElement;
const change = (el: HTMLInputElement, value: string) => {
  fireEvent.input(el, { target: { value } });
  fireEvent.change(el, { target: { value } });
};

describe("helpers", () => {
  it("validates the run limit and the memory budget", () => {
    expect(DEFAULT_MAX_RUNS).toBe(12);
    expect([validMaxRuns("1"), validMaxRuns(String(MAX_RUNS_RANGE.max)), validMaxRuns("0"), validMaxRuns("65"), validMaxRuns("2.5"), validMaxRuns("")]).toEqual([true, true, false, false, false, false]);
    expect([validMemoryMb(""), validMemoryMb(String(MIN_MEMORY_MB)), validMemoryMb("511"), validMemoryMb("1.5")]).toEqual([true, true, false, false]);
    // an absurd value is not stored: the top is 1 TiB, and a float such as 1e300 is not a safe integer
    expect([validMemoryMb(String(MAX_MEMORY_MB)), validMemoryMb(String(MAX_MEMORY_MB + 1)), validMemoryMb("1e300")]).toEqual([true, false, false]);
  });
});

describe("<ParallelSettings>", () => {
  it("shows 12 runs, sharing on and automatic memory by default", async () => {
    vi.spyOn(ipc.settings, "get").mockResolvedValue({});
    render(() => <ParallelSettings />);
    await waitFor(() => expect(runs().value).toBe("12"));
    expect(shared().getAttribute("aria-checked")).toBe("true");
    expect(memory().value).toBe("");
    expect(memory().placeholder).toBe("Automatic");
  });

  it("shows the stored values", async () => {
    vi.spyOn(ipc.settings, "get").mockResolvedValue({ maxRuns: 4, sharedRepoWrites: false, memoryBudgetMb: 2048 });
    render(() => <ParallelSettings />);
    await waitFor(() => expect(runs().value).toBe("4"));
    expect(shared().getAttribute("aria-checked")).toBe("false");
    expect(memory().value).toBe("2048");
  });

  it("saves each control as its own patch", async () => {
    vi.spyOn(ipc.settings, "get").mockResolvedValue({ memoryBudgetMb: 2048 });
    const set = vi.spyOn(ipc.settings, "set").mockResolvedValue({});
    render(() => <ParallelSettings />);
    await waitFor(() => expect(memory().value).toBe("2048"));
    change(runs(), "20");
    await waitFor(() => expect(set).toHaveBeenCalledWith("agents", { maxRuns: 20 }));
    fireEvent.click(shared());
    await waitFor(() => expect(set).toHaveBeenCalledWith("agents", { sharedRepoWrites: false }));
    change(memory(), "4096");
    await waitFor(() => expect(set).toHaveBeenCalledWith("agents", { memoryBudgetMb: 4096 }));
    change(memory(), "");
    await waitFor(() => expect(set).toHaveBeenCalledWith("agents", { memoryBudgetMb: null }));
  });

  it("does not save an invalid number and marks the field", async () => {
    vi.spyOn(ipc.settings, "get").mockResolvedValue({});
    const set = vi.spyOn(ipc.settings, "set").mockResolvedValue({});
    render(() => <ParallelSettings />);
    await waitFor(() => expect(runs().value).toBe("12"));
    change(runs(), "65");
    change(memory(), "100");
    expect(set).not.toHaveBeenCalled();
    expect(runs().getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Enter a whole number in the range shown")).toBeTruthy();
  });

  it("shows the error line when a save is rejected", async () => {
    vi.spyOn(ipc.settings, "get").mockResolvedValue({});
    vi.spyOn(ipc.settings, "set").mockRejectedValue({ message: "disk full" });
    render(() => <ParallelSettings />);
    await waitFor(() => expect(runs().value).toBe("12"));
    change(runs(), "8");
    expect((await screen.findByRole("alert")).textContent).toBe("disk full");
  });
});
