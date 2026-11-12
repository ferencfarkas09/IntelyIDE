import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  list: [] as unknown[],
  revoked: [] as string[],
}));
vi.mock("../../ipc", async (orig) => {
  const mod = await orig<typeof import("../../ipc")>();
  const { createMockIpc } = await import("../../ipc/mock");
  const base = createMockIpc("normal", { delayScale: 0 });
  return {
    ...mod,
    ipc: {
      ...base,
      stopAllowList: async () => structuredClone(state.list),
      stopAllowRevoke: async (id: string) => {
        state.revoked.push(id);
        state.list = (state.list as { id: string }[]).filter((e) => e.id !== id);
        return true;
      },
    },
  };
});

import { setLocale } from "../../i18n";
import { installDomStubs } from "../../store/testing-u2";
import { AllowedStops } from "./SafetySection";

installDomStubs();
afterEach(async () => {
  cleanup();
  state.list = [];
  state.revoked = [];
  await setLocale("en", { persist: false });
});

const entry = { id: "sa-1", repo: "/work/admin", kind: "secretFile", scope: "/work/admin/.env", rule: "read.never-read", addedMs: Date.UTC(2026, 10, 12) };

describe("Settings > Safety: Allowed stops", () => {
  it("says so when nothing is allowed always, and what the list is", async () => {
    render(() => <AllowedStops />);
    expect(await screen.findByText(/Nothing is allowed always/)).toBeTruthy();
    expect(screen.getByText(/never inside a repository, and an agent cannot change this list. At most 100 entries/)).toBeTruthy();
  });

  it("lists each entry with its exact path, kind and repository, and revokes it by keyboard-reachable button", async () => {
    state.list = [entry, { ...entry, id: "sa-2", kind: "cliPrompt", scope: "Contains brace with quote character" }];
    render(() => <AllowedStops />);
    expect(await screen.findAllByTestId("stop-entry")).toHaveLength(2);
    expect(screen.getByText("/work/admin/.env")).toBeTruthy();
    expect(screen.getByText("Read secret file")).toBeTruthy();
    expect(screen.getByText("Claude CLI prompt")).toBeTruthy();
    expect(screen.getByText("2 of 100")).toBeTruthy();
    const revoke = screen.getByRole("button", { name: "Revoke the always-allow for .env" });
    revoke.focus();
    expect(document.activeElement).toBe(revoke);
    fireEvent.click(revoke);
    await waitFor(() => expect(state.revoked).toEqual(["sa-1"]));
    await waitFor(() => expect(screen.getAllByTestId("stop-entry")).toHaveLength(1));
  });

  it("speaks Hungarian", async () => {
    await setLocale("hu", { persist: false });
    state.list = [entry];
    render(() => <AllowedStops />);
    expect(await screen.findByText("Engedélyezett tiltások")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Visszavonás: .env" })).toBeTruthy();
  });
});
