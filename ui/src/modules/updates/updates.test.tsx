import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import { createMockUpdates, MOCK_LATEST } from "../../ipc/mock/updates";
import { availableCommands, resetCommands } from "../../platform/commands";
import { overlays, resetOverlays } from "../../platform/overlay";
import { resetSettings, settingsSections } from "../../platform/settings";
import { resetStatusItems, statusItems } from "../../platform/statusbar";
import { toast } from "../../ui-kit";
import UpdateChip from "./UpdateChip";
import UpdatesSettings from "./UpdatesSettings";
import UpdatesWatcher from "./UpdatesWatcher";
import { applyNotice, chipVisible, resetUpdates } from "./state";
import { register } from "./index";

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const notice = (over = {}) => ({ enabled: true, currentVersion: "0.1.0", state: "available" as const, latest: MOCK_LATEST, disclosedAt: 1, ...over });

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopObserver;
});
afterEach(() => {
  cleanup();
  resetUpdates();
  resetCommands();
  resetOverlays();
  resetSettings();
  resetStatusItems();
  toast.clear();
  vi.restoreAllMocks();
});

describe("updates register()", () => {
  it("adds an overlay, a hidden chip, a settings section and a command, and makes no request", () => {
    const calls = [vi.spyOn(ipc.updates, "status"), vi.spyOn(ipc.updates, "check")];
    register();
    expect(overlays().map((o) => o.id)).toContain("updates");
    expect(statusItems("right").map((i) => i.id)).not.toContain("updates");
    expect(settingsSections().map((s) => s.id)).toContain("updates");
    expect(availableCommands().map((c) => c.id)).toContain("updates.check");
    for (const c of calls) expect(c).not.toHaveBeenCalled();
  });

  it("shows the chip only for an available, not skipped version", () => {
    register();
    expect(chipVisible()).toBe(false);
    applyNotice(notice());
    expect(statusItems("right").map((i) => i.id)).toContain("updates");
    applyNotice(notice({ dismissedVersion: "0.1.1" }));
    expect(chipVisible()).toBe(false);
    applyNotice(notice({ dismissedVersion: "0.1.0" }));
    expect(chipVisible()).toBe(true);
    applyNotice(notice({ state: "upToDate", latest: undefined }));
    expect(chipVisible()).toBe(false);
  });
});

describe("UpdateChip", () => {
  it("opens the card with the honest sentence, and the page opens through openExternal", async () => {
    const open = vi.spyOn(ipc.happy, "openExternal").mockResolvedValue();
    applyNotice(notice());
    render(() => <UpdateChip />);
    fireEvent.click(screen.getByRole("button", { name: /Update available: version 0.1.1/ }));
    expect(await screen.findByText("IntelyIDE 0.1.1 is available")).toBeTruthy();
    expect(screen.getByText(/Notification only: download the new version and replace the app/)).toBeTruthy();
    expect(screen.getByText(/Compare the SHA-256/)).toBeTruthy();
    expect(screen.getByText(/Faster start/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open download page" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(MOCK_LATEST.url));
  });

  it("skips the version through the backend", async () => {
    const mock = createMockUpdates({ latest: MOCK_LATEST });
    const dismiss = vi.spyOn(ipc.updates, "dismiss").mockImplementation(mock.dismiss);
    applyNotice(notice());
    render(() => <UpdateChip />);
    fireEvent.click(screen.getByRole("button", { name: /Update available/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Skip this version" }));
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith("0.1.1"));
    await waitFor(() => expect(chipVisible()).toBe(false));
  });
});

describe("UpdatesSettings", () => {
  it("toggles the switch and runs Check now with a result line", async () => {
    const mock = createMockUpdates({ latest: MOCK_LATEST });
    vi.spyOn(ipc.updates, "status").mockImplementation(mock.status);
    const setEnabled = vi.spyOn(ipc.updates, "setEnabled").mockImplementation(mock.setEnabled);
    const check = vi.spyOn(ipc.updates, "check").mockImplementation(mock.check);
    render(() => <UpdatesSettings />);
    expect(screen.getByText(/IntelyIDE contacts api.github.com once a day/)).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Check for updates automatically" }));
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(false));
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(check).toHaveBeenCalledWith("manual"));
    expect(await screen.findByText("Version 0.1.1 is available")).toBeTruthy();
  });

  it("shows an error code as text", async () => {
    const mock = createMockUpdates({ fail: "rateLimited" });
    vi.spyOn(ipc.updates, "status").mockImplementation(mock.status);
    vi.spyOn(ipc.updates, "check").mockImplementation(mock.check);
    render(() => <UpdatesSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByText(/limiting requests/)).toBeTruthy();
  });
});

describe("UpdatesWatcher", () => {
  it("shows the disclosure once, before any automatic check, and records it", async () => {
    const mock = createMockUpdates({ disclosed: false });
    vi.spyOn(ipc.updates, "status").mockImplementation(mock.status);
    const check = vi.spyOn(ipc.updates, "check");
    const set = vi.spyOn(ipc.settings, "set").mockResolvedValue({} as never);
    render(() => <UpdatesWatcher />);
    await waitFor(() => expect(set).toHaveBeenCalledWith("updates", expect.objectContaining({ disclosedAt: expect.any(Number) })));
    expect(toast.toasts().some((x) => x.description?.includes("api.github.com"))).toBe(true);
    expect(check).not.toHaveBeenCalled();
  });

  it("shows no disclosure when it was seen already, and follows status events", async () => {
    const mock = createMockUpdates({ latest: MOCK_LATEST });
    vi.spyOn(ipc.updates, "status").mockImplementation(mock.status);
    vi.spyOn(ipc.updates, "onStatus").mockImplementation(mock.onStatus);
    render(() => <UpdatesWatcher />);
    await waitFor(() => expect(toast.toasts()).toHaveLength(0));
    await mock.check("manual");
    await waitFor(() => expect(chipVisible()).toBe(true));
  });
});
