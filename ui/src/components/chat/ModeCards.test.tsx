import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PermissionMode } from "../../store/agent-types";
import { installDomStubs } from "../../store/testing-u2";
import { ModeCards } from "./ModeCards";

installDomStubs();
afterEach(cleanup);

const ALL: PermissionMode[] = ["readOnly", "ask", "edit", "automatic", "bypass"];
const cards = () => screen.getAllByRole("radio") as HTMLButtonElement[];
const names = () => cards().map((c) => c.dataset.mode);

function Harness(props: { start?: PermissionMode; modes?: PermissionMode[]; unavailable?: Partial<Record<PermissionMode, string>>; confirm?: PermissionMode[]; onChange?: (m: PermissionMode) => void }) {
  const [value, setValue] = createSignal<PermissionMode | undefined>(props.start);
  return (
    <>
      <span id="lg">Permission mode</span>
      <ModeCards
        modes={props.modes ?? ALL}
        value={value()}
        onChange={(m) => (setValue(m), props.onChange?.(m))}
        labelledBy="lg"
        unavailable={props.unavailable}
        confirm={props.confirm}
      />
    </>
  );
}

describe("<ModeCards>", () => {
  it("is a radio group of the modes in policy order with their one-line explanations", () => {
    render(() => <Harness start="ask" modes={["bypass", "readOnly", "edit", "ask", "automatic"]} />);
    expect(screen.getByRole("radiogroup", { name: "Permission mode" })).toBeTruthy();
    expect(names()).toEqual(ALL);
    expect(cards().map((c) => c.querySelector(".mode-card__label")?.textContent)).toEqual(["Plan / read only", "Ask", "Edit automatically", "Automatic", "Bypass"]);
    for (const c of cards()) expect(document.getElementById(c.getAttribute("aria-describedby")!)?.textContent).toBeTruthy();
    expect(document.getElementById(cards()[0].getAttribute("aria-describedby")!)?.textContent).toBe("Reads, searches and plans only. Nothing is written, only safe read-only commands run, and a plan ends in an approval you can answer.");
  });

  it("shows only the modes it is given (a provider without Automatic and Bypass)", () => {
    render(() => <Harness start="ask" modes={["readOnly", "ask", "edit"]} />);
    expect(names()).toEqual(["readOnly", "ask", "edit"]);
  });

  it("has one tab stop, on the picked card", () => {
    render(() => <Harness start="edit" />);
    expect(cards().map((c) => c.tabIndex)).toEqual([-1, -1, 0, -1, -1]);
    expect(cards().map((c) => c.getAttribute("aria-checked"))).toEqual(["false", "false", "true", "false", "false"]);
  });

  it("enters on the first pickable card when nothing is picked", () => {
    render(() => <Harness unavailable={{ readOnly: "no" }} />);
    expect(cards().map((c) => c.tabIndex)).toEqual([-1, 0, -1, -1, -1]);
  });

  it("arrows move and pick, wrapping around", () => {
    const onChange = vi.fn();
    render(() => <Harness start="ask" onChange={onChange} confirm={[]} />);
    fireEvent.keyDown(cards()[1], { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("edit");
    expect(document.activeElement).toBe(cards()[2]);
    fireEvent.keyDown(cards()[2], { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith("ask");
    fireEvent.keyDown(cards()[1], { key: "ArrowUp" });
    fireEvent.keyDown(cards()[0], { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith("bypass");
  });

  it("an arrow moves over a mode that needs confirming without picking it, and a click picks it", () => {
    const onChange = vi.fn();
    render(() => <Harness start="automatic" onChange={onChange} confirm={["bypass"]} />);
    fireEvent.keyDown(cards()[3], { key: "ArrowDown" });
    expect(document.activeElement).toBe(cards()[4]);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(cards()[4]);
    expect(onChange).toHaveBeenCalledWith("bypass");
  });

  it("announces that Bypass opens a confirmation", () => {
    render(() => <Harness start="ask" confirm={["bypass"]} />);
    expect(cards()[4].getAttribute("aria-haspopup")).toBe("dialog");
    expect(cards()[4].title).toBe("Asks for your confirmation first");
    expect(cards()[0].getAttribute("aria-haspopup")).toBeNull();
  });

  it("disables a mode with its reason in the tooltip and the description, and skips it with the arrows", () => {
    const onChange = vi.fn();
    render(() => <Harness start="readOnly" unavailable={{ ask: "Codex is Weak", edit: "Codex is Weak" }} onChange={onChange} confirm={[]} />);
    expect(cards()[1].getAttribute("aria-disabled")).toBe("true");
    expect(cards()[1].title).toBe("Codex is Weak");
    expect(document.getElementById(cards()[1].getAttribute("aria-describedby")!)?.textContent).toContain("Codex is Weak");
    fireEvent.click(cards()[1]);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(cards()[0], { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("automatic");
  });
});
