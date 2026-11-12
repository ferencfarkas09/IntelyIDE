import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { registerInspectorPanel, resetInspector } from "../../platform/inspector";
import { InspectorSlot } from "./InspectorSlot";

// jsdom has no ResizeObserver; the scroll area watches its size with one.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

afterEach(() => {
  cleanup();
  resetInspector();
});

describe("run details as stacked cards", () => {
  it("shows every registered panel at once, in registry order, each as a named card with a heading", () => {
    registerInspectorPanel({ id: "checkpoints", title: "Checkpoints", order: 25, component: () => <p>three steps</p> });
    registerInspectorPanel({ id: "run", title: "This run", order: 10, component: () => <p>developer</p> });
    render(() => <InspectorSlot />);
    const cards = [...document.querySelectorAll(".inspector__card")];
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual(["This run", "Checkpoints"]);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["This run", "Checkpoints"]);
    // nothing is behind a tab: both bodies are in the page
    expect(screen.queryByRole("tab")).toBeNull();
    expect(within(screen.getByRole("region", { name: "This run" })).getByText("developer")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Checkpoints" })).getByText("three steps")).toBeTruthy();
  });

  it("says so when no module contributed a panel", () => {
    render(() => <InspectorSlot />);
    expect(document.querySelector(".inspector__card")).toBeNull();
    expect(screen.getByRole("complementary").textContent).toMatch(/\S/);
  });
});
