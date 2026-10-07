import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installLayoutStubs } from "../app/testLayout";
import { Splitter } from "./Splitter";

beforeAll(installLayoutStubs);
afterEach(cleanup);

describe("<Splitter collapsed>", () => {
  it("hides the primary pane and the handle but keeps the other pane mounted, so its state survives toggling", () => {
    const [collapsed, setCollapsed] = createSignal(false);
    let mounts = 0;
    function Second() {
      mounts++;
      return <input aria-label="state" />;
    }
    render(() => <Splitter first={<span>first</span>} second={<Second />} defaultSize={300} collapsed={collapsed()} />);
    const input = screen.getByLabelText("state") as HTMLInputElement;
    input.value = "typed";
    expect(screen.getByText("first")).toBeTruthy();
    expect(screen.getByRole("separator")).toBeTruthy();

    setCollapsed(true);
    expect(screen.queryByText("first")).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.getByLabelText("state")).toBe(input);

    setCollapsed(false);
    expect(screen.getByText("first")).toBeTruthy();
    expect(screen.getByLabelText("state")).toBe(input);
    expect(input.value).toBe("typed");
    expect(mounts).toBe(1);
  });

  it("collapses the second pane when it is the primary one", () => {
    const [collapsed, setCollapsed] = createSignal(true);
    render(() => <Splitter direction="column" primary="second" first={<span>top</span>} second={<span>bottom</span>} defaultSize={200} collapsed={collapsed()} />);
    expect(screen.getByText("top")).toBeTruthy();
    expect(screen.queryByText("bottom")).toBeNull();
    setCollapsed(false);
    expect(screen.getByText("bottom")).toBeTruthy();
  });
});
