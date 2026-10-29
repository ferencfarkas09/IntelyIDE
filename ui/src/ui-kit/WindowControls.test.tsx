import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { TitleBar } from "./TitleBar";
import { WindowControls } from "./WindowControls";

describe("WindowControls", () => {
  afterEach(() => {
    cleanup();
    delete document.documentElement.dataset.platform;
  });

  it("minimizes, maximizes and closes through the window actions", () => {
    const actions = { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() };
    const { getByLabelText } = render(() => <WindowControls actions={actions} />);
    fireEvent.click(getByLabelText("Minimize"));
    fireEvent.click(getByLabelText("Maximize"));
    fireEvent.click(getByLabelText("Close"));
    expect(actions.minimize).toHaveBeenCalledOnce();
    expect(actions.toggleMaximize).toHaveBeenCalledOnce();
    expect(actions.close).toHaveBeenCalledOnce();
  });

  it("are part of the title bar on Windows only; the macOS bar keeps its traffic-light spacer and nothing else", () => {
    document.documentElement.dataset.platform = "mac";
    const mac = render(() => <TitleBar left={<span>L</span>} />);
    expect(mac.container.querySelector(".ui-window-controls")).toBeNull();
    expect(mac.container.querySelector(".ui-titlebar__spacer")).not.toBeNull();
    mac.unmount();
    document.documentElement.dataset.platform = "windows";
    const win = render(() => <TitleBar left={<span>L</span>} />);
    const controls = win.container.querySelector(".ui-window-controls");
    expect(controls).not.toBeNull();
    expect(controls?.hasAttribute("data-tauri-drag-region")).toBe(false);
    expect(win.container.querySelectorAll(".ui-window-controls__btn")).toHaveLength(3);
  });
});
