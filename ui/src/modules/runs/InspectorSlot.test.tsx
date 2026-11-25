import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerInspectorPanel, resetInspector } from "../../platform/inspector";
import { InspectorSlot } from "./InspectorSlot";

// jsdom has no ResizeObserver; the scroll area watches its size with one.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

afterEach(() => {
  cleanup();
  resetInspector();
  vi.unstubAllGlobals();
});

/** jsdom has no IntersectionObserver: this one records what is watched and lets a test say what came into view. */
function stubIntersectionObserver() {
  type Entry = { target: Element; isIntersecting: boolean };
  const observers: { cb: (entries: Entry[]) => void; options?: IntersectionObserverInit; targets: Set<Element>; disconnected: boolean }[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private self: (typeof observers)[number];
      constructor(cb: (entries: Entry[]) => void, options?: IntersectionObserverInit) {
        this.self = { cb, options, targets: new Set(), disconnected: false };
        observers.push(this.self);
      }
      observe(el: Element) { this.self.targets.add(el); }
      unobserve(el: Element) { this.self.targets.delete(el); }
      disconnect() { this.self.targets.clear(); this.self.disconnected = true; }
    },
  );
  const of = (panel: string) => observers.find((o) => [...o.targets].some((el) => el.closest(`[data-panel="${panel}"]`)));
  return {
    observers,
    watched: (panel: string) => !!of(panel),
    root: (panel: string) => of(panel)?.options?.root,
    /** Reports the card as in view or not; false when nobody watches it any more. */
    report(panel: string, isIntersecting: boolean) {
      const o = of(panel);
      if (!o) return false;
      o.cb([...o.targets].map((target) => ({ target, isIntersecting })));
      return true;
    },
  };
}

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

  it("loads a panel only when its card comes into view of the scroll area, and keeps it afterwards", () => {
    const io = stubIntersectionObserver();
    const mounted = { run: 0, checkpoints: 0, files: 0 };
    registerInspectorPanel({ id: "run", title: "This run", order: 10, component: () => (mounted.run++, <p>developer</p>) });
    registerInspectorPanel({ id: "checkpoints", title: "Checkpoints", order: 25, component: () => (mounted.checkpoints++, <p>three steps</p>) });
    registerInspectorPanel({ id: "files", title: "Files", order: 30, component: () => (mounted.files++, <p>two files</p>) });
    render(() => <InspectorSlot />);
    // every card and heading is there, no panel component has run, and each body holds the tall placeholder
    expect(document.querySelectorAll(".inspector__card")).toHaveLength(3);
    expect(mounted).toEqual({ run: 0, checkpoints: 0, files: 0 });
    expect(document.querySelectorAll(".inspector__seen > .inspector__placeholder")).toHaveLength(3);
    expect(screen.queryByText("developer")).toBeNull();
    // the cards are watched against the element that scrolls, not the window
    const viewport = document.querySelector(".inspector__scroll .ui-scroll__viewport");
    expect(viewport).not.toBeNull();
    for (const id of ["run", "checkpoints", "files"]) expect(io.root(id)).toBe(viewport);

    // an entry that does not intersect changes nothing
    io.report("checkpoints", false);
    expect(mounted.checkpoints).toBe(0);

    // the first card is in view: only its panel loads
    io.report("run", true);
    expect(within(screen.getByRole("region", { name: "This run" })).getByText("developer")).toBeTruthy();
    expect(mounted).toEqual({ run: 1, checkpoints: 0, files: 0 });
    expect(screen.queryByText("three steps")).toBeNull();
    expect(document.querySelectorAll(".inspector__seen > .inspector__placeholder")).toHaveLength(2);

    // scrolled to the second
    io.report("checkpoints", true);
    expect(within(screen.getByRole("region", { name: "Checkpoints" })).getByText("three steps")).toBeTruthy();
    expect(mounted).toEqual({ run: 1, checkpoints: 1, files: 0 });

    // a loaded panel is no longer watched, so leaving the view cannot unload it
    expect(io.watched("run")).toBe(false);
    expect(io.report("run", false)).toBe(false);
    for (const o of io.observers.filter((x) => x.disconnected)) o.cb([{ target: document.body, isIntersecting: false }]);
    expect(screen.getByText("developer")).toBeTruthy();
    expect(screen.getByText("three steps")).toBeTruthy();
    expect(mounted).toEqual({ run: 1, checkpoints: 1, files: 0 });
    expect(io.watched("files")).toBe(true);
  });
});
