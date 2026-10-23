import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDomStubs } from "../../store/testing-u2";
import { setRegistryApi, type RegistryApi } from "./api";
import AccountSection from "./AccountSection";
import { dialog, resetAccount } from "./store";
import type { RegistryStatus, StoredData } from "./types";

installDomStubs();

const declined: RegistryStatus = { state: "declined", name: null, email: null, newsletter: null, notice: "2026-10-23", consentedNotice: null, needsConsent: false, url: "https://api.example.invalid" };
const registered: RegistryStatus = { ...declined, state: "registered", name: "Anna", email: "anna@example.com", newsletter: "none", consentedNotice: "2026-10-23" };
const stored: StoredData = {
  notice: "2026-10-23",
  user: { name: "Anna", email: "anna@example.com", consentNotice: "2026-10-23", consentAt: 1_792_000_000, newsletter: "none" },
  computer: { os: "macos", os_version: "15.4", arch: "aarch64", cpu_cores: 10, ram_gb: 32, locale: "hu-HU", tz: "Europe/Budapest", app_version: "1.13.0", country: "HU", region: "Budapest", city: "Budapest", first_seen: 1_792_000_000, last_seen: 1_792_050_000, launches: 7 },
  computers: 2,
};

function fake(initial: RegistryStatus, over: Partial<RegistryApi> = {}) {
  let current = initial;
  const api = {
    status: vi.fn(async () => current),
    register: vi.fn(),
    decline: vi.fn(),
    me: vi.fn(async () => stored),
    newsletter: vi.fn(async (on: boolean) => (current = { ...current, newsletter: on ? "pending" : "unsubscribed" })),
    forget: vi.fn(async () => (current = declined)),
    reconsent: vi.fn(),
    openExternal: vi.fn(async () => {}),
    ...over,
  } as unknown as RegistryApi & { [K in keyof RegistryApi]: ReturnType<typeof vi.fn> };
  setRegistryApi(api);
  return api;
}

beforeEach(() => resetAccount());
afterEach(() => {
  cleanup();
  setRegistryApi(undefined);
});

describe("Settings > Account & data", () => {
  it("says nothing is sent when the computer is not registered, and offers to register", async () => {
    fake(declined);
    render(() => <AccountSection />);
    expect(await screen.findByText("Not registered. Nothing is sent.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete my data" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Register this computer..." }));
    expect(dialog()).toBe("register");
  });

  it("shows who is registered and reads what is stored from the registry", async () => {
    const api = fake(registered);
    render(() => <AccountSection />);
    expect(await screen.findByText("Registered as Anna (anna@example.com).")).toBeTruthy();
    expect(api.me).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    const table = await screen.findByRole("table");
    const cell = (label: string) => within(table).getByText(label).closest("tr")!.querySelector("td")!.textContent;
    expect(cell("System")).toBe("macos 15.4");
    expect(cell("Memory")).toBe("32 GB");
    expect(cell("Place")).toBe("Budapest, Budapest, HU");
    expect(cell("Computers registered with this address")).toBe("2");
    expect(cell("Starts")).toBe("7");
    expect(within(table).queryByText(/fingerprint|machine_hash|token/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("turns the newsletter on and off", async () => {
    const api = fake(registered);
    render(() => <AccountSection />);
    await screen.findByText("Not subscribed");
    fireEvent.click(screen.getByRole("button", { name: "Subscribe" }));
    await waitFor(() => expect(api.newsletter).toHaveBeenCalledWith(true));
    expect(await screen.findByText("Waiting for your confirmation")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe" }));
    await waitFor(() => expect(api.newsletter).toHaveBeenLastCalledWith(false));
    expect(await screen.findByText("Unsubscribed")).toBeTruthy();
  });

  it("asks before deleting, and deleting ends the registration", async () => {
    const api = fake(registered);
    render(() => <AccountSection />);
    await screen.findByText("Registered as Anna (anna@example.com).");
    fireEvent.click(screen.getByRole("button", { name: "Delete my data" }));
    const d = await screen.findByRole("alertdialog", { name: "Delete your data?" });
    expect(api.forget).not.toHaveBeenCalled();
    fireEvent.click(within(d).getByRole("button", { name: "Keep it" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.forget).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete my data" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete my data" }));
    await waitFor(() => expect(api.forget).toHaveBeenCalledOnce());
    expect(await screen.findByText("Not registered. Nothing is sent.")).toBeTruthy();
  });

  it("keeps the registration and says so when the registry cannot be reached for a delete", async () => {
    const api = fake(registered, { forget: vi.fn(async () => Promise.reject({ code: "offline", message: "x" })) });
    render(() => <AccountSection />);
    await screen.findByText("Registered as Anna (anna@example.com).");
    fireEvent.click(screen.getByRole("button", { name: "Delete my data" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete my data" }));
    await waitFor(() => expect(api.forget).toHaveBeenCalledOnce());
    expect(screen.getByText("Registered as Anna (anna@example.com).")).toBeTruthy();
  });
});
