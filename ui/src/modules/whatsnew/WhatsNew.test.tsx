import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const app = vi.hoisted(() => ({ version: "1.7.0" }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve(app.version) }));

import { ipc, type Ipc } from "../../ipc";
import { setLocale } from "../../i18n";
import { ABOUT } from "../../shell/aboutText";
import { refreshRegistry, resetWorkspacesForTest } from "../../store/workspaces";
import { installDomStubs } from "../../store/testing-u2";
import WhatsNew from "./WhatsNew";
import { resetWhatsNew, SEEN_KEY, openWhatsNew, seenVersion } from "./state";

installDomStubs();

const registryWith = (count: number) =>
  ({ workspaces: { list: async () => ({ version: 1, rev: 1, activeId: count ? "w1" : null, pinned: false, workspaces: Array.from({ length: count }, (_, i) => ({ id: `w${i + 1}`, name: `W${i + 1}`, repos: [] })) }) } }) as unknown as Ipc;

const inApp = () => ((window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {});
const outsideApp = () => delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;

beforeEach(async () => {
  localStorage.removeItem(SEEN_KEY);
  app.version = "1.7.0";
  inApp();
  vi.spyOn(ipc.settings, "safetyStatus").mockResolvedValue({ jail: "off" } as never);
  await setLocale("en");
});
afterEach(() => {
  cleanup();
  resetWhatsNew();
  resetWorkspacesForTest();
  outsideApp();
  vi.restoreAllMocks();
  localStorage.removeItem(SEEN_KEY);
});

const start = async (workspaces: number) => {
  render(() => <WhatsNew />);
  await refreshRegistry(registryWith(workspaces));
};
const dialog = () => screen.findByRole("dialog", {}, { timeout: 4000 });

describe("after an update", () => {
  it("opens once with what came in, and remembers the version when it is closed", async () => {
    localStorage.setItem(SEEN_KEY, "1.6.0");
    await start(1);
    const d = within(await dialog());
    expect(d.getByRole("heading", { name: "What's new in IntelyIDE 1.7.0" })).toBeTruthy();
    expect(d.getByText("You updated from 1.6.0. Here is what came in and what was fixed.")).toBeTruthy();
    expect(d.getByText("Runs start much faster")).toBeTruthy();
    expect(d.getAllByText("Fixed").length).toBeGreaterThan(0);
    // an older release is not listed: the person has seen it
    expect(d.queryByText("Team invite links open the app")).toBeNull();
    expect(seenVersion()).toBe("1.6.0");

    fireEvent.click(d.getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(seenVersion()).toBe("1.7.0");

    // the next start does not show it again
    cleanup();
    resetWorkspacesForTest();
    await start(1);
    await new Promise((r) => setTimeout(r, 1200));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lists every release that was skipped, newest first, the newest open", async () => {
    localStorage.setItem(SEEN_KEY, "1.5.0");
    await start(2);
    const d = within(await dialog());
    const heads = d.getAllByRole("button", { expanded: true }).concat(d.queryAllByRole("button", { expanded: false }));
    expect(d.getByRole("region", { name: "Version 1.7.0" })).toBeTruthy();
    expect(d.getByRole("region", { name: "Version 1.6.0" })).toBeTruthy();
    expect(d.getByRole("region", { name: "Version 1.5.1" })).toBeTruthy();
    expect(d.queryByRole("region", { name: "Version 1.5.0" })).toBeNull();
    expect(heads.length).toBeGreaterThan(2);
    expect(within(d.getByRole("region", { name: "Version 1.7.0" })).getByText("Runs start much faster")).toBeTruthy();
  });

  it("shows only the running release for an app that was updated from a build that had no such window", async () => {
    await start(1);
    const d = within(await dialog());
    expect(d.getByText("The latest changes: what came in and what was fixed.")).toBeTruthy();
    expect(d.getByRole("region", { name: "Version 1.7.0" })).toBeTruthy();
    expect(d.queryByRole("region", { name: "Version 1.6.0" })).toBeNull();
  });

  it("speaks Hungarian to a Hungarian user", async () => {
    await setLocale("hu");
    localStorage.setItem(SEEN_KEY, "1.6.0");
    await start(1);
    const d = within(await dialog());
    expect(d.getByRole("heading", { name: "Újdonságok az IntelyIDE 1.7.0 verzióban" })).toBeTruthy();
    expect(d.getByText("A futások sokkal gyorsabban indulnak")).toBeTruthy();
    expect(d.getAllByText("Javítva").length).toBeGreaterThan(0);
    fireEvent.click(d.getByRole("button", { name: "Rendben" }));
  });

  it("opens the release page from the full changelog button", async () => {
    localStorage.setItem(SEEN_KEY, "1.6.0");
    const open = vi.spyOn(ipc.happy, "openExternal").mockResolvedValue(undefined as never);
    await start(1);
    const d = within(await dialog());
    fireEvent.click(d.getByRole("button", { name: "Full changelog" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(`${ABOUT.source}/releases/tag/v1.7.0`));
  });
});

describe("when nothing is new", () => {
  const stayedClosed = async () => {
    await new Promise((r) => setTimeout(r, 1200));
    expect(screen.queryByRole("dialog")).toBeNull();
  };

  it("only writes the version down on the first start of a fresh install", async () => {
    await start(0);
    await waitFor(() => expect(seenVersion()).toBe("1.7.0"));
    await stayedClosed();
  });

  it("stays closed when the version was already seen", async () => {
    localStorage.setItem(SEEN_KEY, "1.7.0");
    await start(1);
    await stayedClosed();
  });

  it("stays closed outside the desktop app, and under the read-only and test jails", async () => {
    localStorage.setItem(SEEN_KEY, "1.6.0");
    outsideApp();
    await start(1);
    await stayedClosed();
    expect(seenVersion()).toBe("1.6.0");
    cleanup();
    resetWorkspacesForTest();
    inApp();
    vi.mocked(ipc.settings.safetyStatus).mockResolvedValue({ jail: "e2e" } as never);
    await start(1);
    await stayedClosed();
    expect(seenVersion()).toBe("1.6.0");
  });

  it("writes the version down after a downgrade without showing anything", async () => {
    localStorage.setItem(SEEN_KEY, "1.9.0");
    await start(1);
    await waitFor(() => expect(seenVersion()).toBe("1.7.0"));
    await stayedClosed();
  });
});

describe("the command", () => {
  it("opens the latest releases on request, whatever was seen", async () => {
    localStorage.setItem(SEEN_KEY, "1.7.0");
    render(() => <WhatsNew />);
    await openWhatsNew();
    const d = within(await screen.findByRole("dialog"));
    expect(d.getByText("The latest changes: what came in and what was fixed.")).toBeTruthy();
    expect(d.getByRole("region", { name: "Version 1.7.0" })).toBeTruthy();
    expect(d.getByRole("region", { name: "Version 1.6.0" })).toBeTruthy();
    fireEvent.click(d.getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
