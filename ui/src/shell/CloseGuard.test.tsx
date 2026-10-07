import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: { command: string; args?: Record<string, unknown> }[] = [];
let closeRequested: (() => void) | undefined;
vi.mock("../ipc/rpc", () => ({
  call: async (command: string, args?: Record<string, unknown>) => void calls.push({ command, args }),
  subscribe: (event: string, cb: () => void) => {
    if (event === "app:close-requested") closeRequested = cb;
    return () => {};
  },
}));

import { registerUnsavedSource, resetUnsavedSources } from "../platform/closeGuard";
import { CloseGuard, listTitles } from "./CloseGuard";

beforeEach(() => {
  calls.length = 0;
  closeRequested = undefined;
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
  cleanup();
  resetUnsavedSources();
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
});

const last = (command: string) => calls.filter((c) => c.command === command).at(-1)?.args;

describe("listTitles", () => {
  it("names up to three files and counts the rest", () => {
    expect(listTitles([])).toBe("");
    expect(listTitles(["a.ts"])).toBe("a.ts");
    expect(listTitles(["a.ts", "b.ts"])).toBe("a.ts and b.ts");
    expect(listTitles(["a", "b", "c"])).toBe("a, b and c");
    expect(listTitles(["a", "b", "c", "d", "e"])).toBe("a, b, c and 2 more");
  });
});

describe("<CloseGuard>", () => {
  it("arms the host only while something is unsaved", async () => {
    const [titles, setTitles] = createSignal<string[]>([]);
    registerUnsavedSource({ id: "editor", titles, saveAll: async () => true });
    render(() => <CloseGuard />);
    await waitFor(() => expect(last("close_guard_arm")).toEqual({ armed: false }));
    setTitles(["a.ts"]);
    await waitFor(() => expect(last("close_guard_arm")).toEqual({ armed: true }));
    setTitles([]);
    await waitFor(() => expect(last("close_guard_arm")).toEqual({ armed: false }));
  });

  it("asks Save all / Don't save / Cancel when the host holds a close back, and Cancel keeps the window", async () => {
    registerUnsavedSource({ id: "editor", titles: () => ["a.ts", "b.ts"], saveAll: async () => true });
    render(() => <CloseGuard />);
    closeRequested!();
    expect(await screen.findByText("Save 2 files before closing?")).toBeTruthy();
    expect(screen.getByText(/a\.ts and b\.ts have unsaved changes/)).toBeTruthy();
    for (const name of ["Cancel", "Don't save", "Save all"]) expect(screen.getByRole("button", { name })).toBeTruthy();
    await waitFor(() => expect(last("close_guard_dialog")).toEqual({ open: true }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(last("close_guard_dialog")).toEqual({ open: false }));
    expect(calls.some((c) => c.command === "close_guard_exit")).toBe(false);
  });

  it("leaves without saving on Don't save", async () => {
    registerUnsavedSource({ id: "editor", titles: () => ["a.ts"], saveAll: async () => true });
    render(() => <CloseGuard />);
    closeRequested!();
    fireEvent.click(await screen.findByRole("button", { name: "Don't save" }));
    expect(calls.some((c) => c.command === "close_guard_exit")).toBe(true);
  });

  it("saves everything first and leaves only when all of it was saved", async () => {
    const saveAll = vi.fn(async () => false);
    registerUnsavedSource({ id: "editor", titles: () => ["a.ts"], saveAll });
    render(() => <CloseGuard />);
    closeRequested!();
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveAll).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.some((c) => c.command === "close_guard_exit")).toBe(false);

    saveAll.mockResolvedValue(true);
    closeRequested!();
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.command === "close_guard_exit")).toBe(true));
  });

  it("just leaves when the request arrives with nothing left to lose", async () => {
    render(() => <CloseGuard />);
    closeRequested!();
    await waitFor(() => expect(calls.some((c) => c.command === "close_guard_exit")).toBe(true));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("arms the host for a live production connection and asks Cancel / Disconnect and quit in its own words", async () => {
    const [open, setOpen] = createSignal(["Acme production"]);
    const end = vi.fn(async () => true);
    registerUnsavedSource({ id: "prod", kind: "session", titles: open, saveAll: end, copy: () => ({ title: "Quit with a production connection open?", description: "Acme production is connected.", confirm: "Disconnect and quit" }) });
    render(() => <CloseGuard />);
    await waitFor(() => expect(last("close_guard_arm")).toEqual({ armed: true }));
    closeRequested!();
    expect(await screen.findByText("Quit with a production connection open?")).toBeTruthy();
    expect(screen.getByText("Acme production is connected.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Don't save" })).toBeNull();
    // Cancel keeps the window and the connection
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(last("close_guard_dialog")).toEqual({ open: false }));
    expect(end).not.toHaveBeenCalled();
    expect(calls.some((c) => c.command === "close_guard_exit")).toBe(false);
    // the connection ends elsewhere: the guard disarms and a close just leaves
    setOpen([]);
    await waitFor(() => expect(last("close_guard_arm")).toEqual({ armed: false }));
  });

  it("ends the sessions first and leaves on Disconnect and quit, even when one cannot be ended", async () => {
    const end = vi.fn(async () => { throw new Error("already gone"); });
    registerUnsavedSource({ id: "prod", kind: "session", titles: () => ["Acme production"], saveAll: end, copy: () => ({ title: "Quit?", description: "d", confirm: "Disconnect and quit" }) });
    render(() => <CloseGuard />);
    closeRequested!();
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect and quit" }));
    await waitFor(() => expect(calls.some((c) => c.command === "close_guard_exit")).toBe(true));
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("unsaved work wins: the normal dialog is shown while both exist", async () => {
    registerUnsavedSource({ id: "editor", titles: () => ["a.ts"], saveAll: async () => true });
    registerUnsavedSource({ id: "prod", kind: "session", titles: () => ["Acme production"], saveAll: async () => true, copy: () => ({ title: "Quit?", description: "d", confirm: "Disconnect and quit" }) });
    render(() => <CloseGuard />);
    closeRequested!();
    expect(await screen.findByText("Save changes before closing?")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Disconnect and quit" })).toBeNull();
  });
});
