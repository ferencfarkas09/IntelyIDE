import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Popover } from "./Popover";

// jsdom has no ResizeObserver; the popover measures its anchor with one
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

// jsdom lays nothing out: every element counts as shown, as in the app
const rects = HTMLElement.prototype.getClientRects;
beforeAll(() => void (HTMLElement.prototype.getClientRects = function () { return [{}] as unknown as DOMRectList; }));
afterAll(() => void (HTMLElement.prototype.getClientRects = rects));
afterEach(cleanup);

const open = async (kind: "dialog" | "menu" = "dialog") => {
  render(() => (
    <>
      <button type="button">before</button>
      <Popover kind={kind} aria-label="Panel" trigger={(p) => <button {...p} type="button">open</button>}>
        {() => (
          <div>
            <button type="button">first</button>
            <button type="button">second</button>
            <button type="button">last</button>
          </div>
        )}
      </Popover>
      <button type="button">after</button>
    </>
  ));
  fireEvent.click(screen.getByRole("button", { name: "open" }));
  await Promise.resolve();
  await Promise.resolve();
};

describe("a dialog popover and the Tab key", () => {
  it("wraps Tab from the last control to the first, and Shift+Tab from the first to the last, staying open", async () => {
    await open();
    const panel = screen.getByRole("dialog", { name: "Panel" });
    const [first, , last] = ["first", "second", "last"].map((n) => screen.getByRole("button", { name: n }));
    last.focus();
    const tab = fireEvent.keyDown(last, { key: "Tab" });
    expect(tab, "the browser's own move is cancelled").toBe(false);
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    expect(panel.isConnected).toBe(true);
  });

  it("leaves Tab alone between controls inside, and in a menu", async () => {
    await open();
    const first = screen.getByRole("button", { name: "first" });
    first.focus();
    expect(fireEvent.keyDown(first, { key: "Tab" }), "the browser moves to the next control itself").toBe(true);
    cleanup();
    await open("menu");
    const last = screen.getByRole("button", { name: "last" });
    last.focus();
    expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(true);
  });
});
