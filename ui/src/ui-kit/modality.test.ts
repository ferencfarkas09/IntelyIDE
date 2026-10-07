import { afterEach, describe, expect, it } from "vitest";
import { installInputModality } from "./modality";

afterEach(() => delete document.documentElement.dataset.input);

describe("input modality", () => {
  it("follows the last input: pointer movement or a key press, but not a bare modifier", () => {
    installInputModality(document);
    document.dispatchEvent(new PointerEvent("pointermove"));
    expect(document.documentElement.dataset.input).toBe("pointer");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(document.documentElement.dataset.input).toBe("keyboard");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta" }));
    document.dispatchEvent(new PointerEvent("pointermove"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" }));
    expect(document.documentElement.dataset.input).toBe("pointer");
  });
});
