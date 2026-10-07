import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

const { state, setState, target, setTarget } = await vi.hoisted(async () => {
  const { createSignal } = await import("solid-js");
  const [state, setState] = createSignal<"loading" | "ready" | "empty" | "switching" | "error">("loading");
  const [target, setTarget] = createSignal<{ id: string | null; name: string | null } | null>(null);
  return { state, setState, target, setTarget };
});
vi.mock("../store/workspace", () => ({ workspaceState: state }));
vi.mock("../store/workspaces", () => ({ switchTarget: target }));

import { Splash } from "./Splash";

describe("<Splash>", () => {
  afterEach(() => {
    cleanup();
    setState("loading");
    setTarget(null);
  });

  it("shows while the workspace loads and closes once it is ready", async () => {
    const { container } = render(() => <Splash />);
    expect(container.querySelector(".splash")?.getAttribute("data-state")).toBe("open");
    setState("ready");
    await Promise.resolve();
    expect(container.querySelector(".splash")?.getAttribute("data-state")).toBe("closed");
    await new Promise((r) => setTimeout(r, 220));
    expect(container.querySelector(".splash")).toBeNull();
  });

  it("covers the window during a switch, names the target, and is busy for assistive tech", () => {
    setState("switching");
    setTarget({ id: "w2", name: "Side projects" });
    const { container } = render(() => <Splash />);
    const splash = container.querySelector(".splash")!;
    expect(splash.getAttribute("aria-label")).toBe("Switching to Side projects...");
    expect(splash.getAttribute("aria-busy")).toBe("true");
    expect(splash.querySelector(".splash__name")?.textContent).toBe("Switching to Side projects...");
  });

  it("says it is closing when no workspace is the target", () => {
    setState("switching");
    setTarget({ id: null, name: null });
    const { container } = render(() => <Splash />);
    expect(container.querySelector(".splash")?.getAttribute("aria-label")).toBe("Closing workspace...");
  });

  it("stays out of the way on Welcome", () => {
    setState("empty");
    const { container } = render(() => <Splash />);
    expect(container.querySelector(".splash")).toBeNull();
  });
});
