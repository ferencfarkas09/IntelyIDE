import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TermView } from "./view";

vi.mock("./view", () => ({
  createView: vi.fn(async () => {
    const host = document.createElement("div");
    host.className = "term-host";
    return { term: { cols: 80, rows: 24 }, host, write: vi.fn(), attach: (p: HTMLElement) => p.appendChild(host), detach: () => host.remove(), fit: vi.fn(), focus: vi.fn(), setWebgl: vi.fn(async () => {}), setTheme: vi.fn(), dispose: vi.fn() } as unknown as TermView;
  }),
}));

const store = await import("./store");
const { default: TerminalPanel } = await import("./TerminalPanel");

afterEach(() => {
  cleanup();
  store.resetTerminals();
  localStorage.clear();
});

describe("<TerminalPanel>", () => {
  it("starts a shell on first show and renders it as a selected tab", async () => {
    render(() => <TerminalPanel />);
    const tab = await screen.findByRole("tab", { selected: true });
    expect(tab).toBeTruthy();
    expect(document.querySelectorAll(".term-host")).toHaveLength(1);
  });

  it("adds a tab with New terminal, switches by click and closes with the tab's button", async () => {
    render(() => <TerminalPanel />);
    await screen.findByRole("tab");
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    const [first, second] = screen.getAllByRole("tab");
    expect(second.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(first);
    expect(first.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getAllByRole("button", { name: /^Close / })[0]);
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
  });

  it("keeps the terminals when the panel is hidden and shown again", async () => {
    const first = render(() => <TerminalPanel />);
    await screen.findByRole("tab");
    const id = store.activeTerminalId();
    first.unmount();
    expect(document.querySelectorAll(".term-host")).toHaveLength(0);
    render(() => <TerminalPanel />);
    expect(store.terminals()).toHaveLength(1);
    expect(store.activeTerminalId()).toBe(id);
    await waitFor(() => expect(document.querySelectorAll(".term-host")).toHaveLength(1));
  });
});
