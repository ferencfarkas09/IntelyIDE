import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Checkbox } from "./Checkbox";
import type { CheckState } from "./checkbox-logic";

describe("<Checkbox>", () => {
  afterEach(cleanup);

  it("exposes mixed through aria-checked and indeterminate", () => {
    render(() => <Checkbox checked="mixed" aria-label="repo" />);
    const box = screen.getByLabelText("repo") as HTMLInputElement;
    expect(box.getAttribute("aria-checked")).toBe("mixed");
    expect(box.indeterminate).toBe(true);
    expect(box.checked).toBe(false);
  });

  it("selects everything when a mixed box is clicked", () => {
    const [state, setState] = createSignal<CheckState>("mixed");
    render(() => <Checkbox checked={state()} onChange={setState} aria-label="repo" />);
    const box = screen.getByLabelText("repo") as HTMLInputElement;
    fireEvent.click(box);
    expect(state()).toBe(true);
    fireEvent.click(box);
    expect(state()).toBe(false);
  });

  it("does not fire when disabled", () => {
    let calls = 0;
    render(() => <Checkbox checked={false} disabled onChange={() => calls++} aria-label="locked" />);
    fireEvent.click(screen.getByLabelText("locked"));
    expect(calls).toBe(0);
  });

  it("reads a computed disabled prop in its handler without creating ownerless computations", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const [blocked] = createSignal(false);
    const [on, setOn] = createSignal(false);
    render(() => <Checkbox checked={on()} disabled={blocked() && !on()} onChange={setOn} aria-label="amend" />);
    fireEvent.click(screen.getByLabelText("amend"));
    expect(on()).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("createRoot"))).toBe(false);
    warn.mockRestore();
  });
});
