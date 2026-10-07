import { describe, expect, it, vi } from "vitest";
import { whenConnected } from "./whenConnected";

describe("whenConnected", () => {
  it("waits for an element that is inserted later and then hands it over once", async () => {
    const el = document.createElement("div");
    const use = vi.fn();
    whenConnected(el, use);
    await new Promise((r) => setTimeout(r, 40));
    expect(use).not.toHaveBeenCalled();
    document.body.append(el);
    await vi.waitFor(() => expect(use).toHaveBeenCalledTimes(1));
    expect(use).toHaveBeenCalledWith(el);
    el.remove();
  });

  it("hands over an element that is already in the document right away", async () => {
    const el = document.createElement("div");
    document.body.append(el);
    const use = vi.fn();
    whenConnected(el, use);
    await Promise.resolve();
    expect(use).toHaveBeenCalledWith(el);
    el.remove();
  });
});
