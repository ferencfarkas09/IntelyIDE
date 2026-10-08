import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installDomStubs } from "../../store/testing-u2";
import { createMockSentry, setSentryApi, type SentryApi } from "./api";
import SentrySection from "./SentrySection";
import { resetSentry } from "./store";
import type { SentryConnection, SentryStatus } from "./types";

installDomStubs();

function rig(over: Partial<SentryApi> = {}, start: Partial<SentryStatus> = {}) {
  const base = createMockSentry();
  let state: SentryStatus = { baseUrl: "https://sentry.io", org: "acme", hasToken: false, configured: false, ...start };
  const calls = { config: [] as { baseUrl?: string; org?: string }[], tokens: [] as string[], cleared: 0 };
  const api: SentryApi = {
    ...base,
    status: async () => ({ ...state }),
    setConfig: async (p) => (calls.config.push(p), (state = { ...state, ...(p.baseUrl !== undefined ? { baseUrl: p.baseUrl } : {}), ...(p.org !== undefined ? { org: p.org } : {}) }), (state.configured = state.hasToken && state.org !== ""), { ...state }),
    saveToken: async (token) => (calls.tokens.push(token), (state = { ...state, hasToken: true, configured: state.org !== "" }), { ok: true, orgName: "Acme Inc", user: "Ferenc Farkas", problem: null } satisfies SentryConnection),
    clearToken: async () => (calls.cleared++, (state = { ...state, hasToken: false, configured: false }), { ...state }),
    ...over,
  };
  setSentryApi(api);
  return calls;
}

beforeEach(() => {
  resetSentry();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  setSentryApi(undefined);
});

describe("<SentrySection>", () => {
  it("shows the saved address and organization and saves what was typed, trimmed", async () => {
    const calls = rig();
    render(() => <SentrySection />);
    const org = (await screen.findByLabelText("Organization")) as HTMLInputElement;
    await waitFor(() => expect(org.value).toBe("acme"));
    expect((screen.getByLabelText("Sentry address") as HTMLInputElement).value).toBe("https://sentry.io");
    fireEvent.input(org, { target: { value: "  shop  " } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save address and organization" })[0]);
    await waitFor(() => expect(calls.config).toEqual([{ baseUrl: "https://sentry.io", org: "shop" }]));
    expect(await screen.findByText("Saved")).toBeTruthy();
  });

  it("saves the token, tells who it belongs to, empties the field and offers to remove it", async () => {
    const calls = rig();
    render(() => <SentrySection />);
    const field = (await screen.findByLabelText("Token")) as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(screen.getByText("No token yet.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove token" })).toBeNull();
    fireEvent.input(field, { target: { value: "sntrys_abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));
    await waitFor(() => expect(calls.tokens).toEqual(["sntrys_abc"]));
    expect(await screen.findByText(/Connected to Acme Inc as Ferenc Farkas/)).toBeTruthy();
    await waitFor(() => expect(field.value).toBe(""));
    expect(screen.getByText("A token is saved in your Keychain.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove token" }));
    await waitFor(() => expect(calls.cleared).toBe(1));
    expect(await screen.findByText("No token yet.")).toBeTruthy();
  });

  it("says the saved token was removed when another address is saved, and keeps it for the same address", async () => {
    const calls = rig(
      {
        setConfig: async (p) => {
          calls.config.push(p);
          const moved = p.baseUrl !== undefined && p.baseUrl !== "https://sentry.io";
          return { baseUrl: p.baseUrl ?? "https://sentry.io", org: p.org ?? "acme", hasToken: !moved, configured: !moved };
        },
      },
      { hasToken: true, configured: true },
    );
    render(() => <SentrySection />);
    const base = (await screen.findByLabelText("Sentry address")) as HTMLInputElement;
    await waitFor(() => expect(screen.getByText("A token is saved in your Keychain.")).toBeTruthy());
    fireEvent.click(screen.getAllByRole("button", { name: "Save address and organization" })[0]);
    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(screen.getByText("A token is saved in your Keychain.")).toBeTruthy();
    expect(screen.queryByText(/saved token was removed/)).toBeNull();
    fireEvent.input(base, { target: { value: "https://sentry.example.invalid" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save address and organization" })[0]);
    expect(await screen.findByText(/saved token was removed/)).toBeTruthy();
    expect(screen.queryByText("A token is saved in your Keychain.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove token" })).toBeNull();
  });

  it("keeps what was typed when Sentry does not take the token, and says why", async () => {
    rig({ saveToken: async () => ({ ok: false, orgName: null, user: null, problem: { code: "unauthorized", message: "no" } }) });
    render(() => <SentrySection />);
    const field = (await screen.findByLabelText("Token")) as HTMLInputElement;
    fireEvent.input(field, { target: { value: "sntrys_bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));
    expect(await screen.findByText(/did not accept the token/)).toBeTruthy();
    expect(field.value).toBe("sntrys_bad");
  });

  it("warns when the token is not a person's, and does not test without a token", async () => {
    rig({ test: async () => ({ ok: true, orgName: "Acme Inc", user: null, problem: null }) }, { hasToken: true, configured: true });
    render(() => <SentrySection />);
    fireEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/Connected to Acme Inc\./)).toBeTruthy();
    expect(screen.getByText(/not a person's/)).toBeTruthy();
    cleanup();
    resetSentry();
    rig();
    render(() => <SentrySection />);
    const test = await screen.findByRole("button", { name: "Test connection" });
    expect(test.getAttribute("aria-disabled")).toBe("true");
  });
});
