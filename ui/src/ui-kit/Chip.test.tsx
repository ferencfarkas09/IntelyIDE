import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chip } from "./Chip";
import { ChoiceCard } from "./ChoiceCard";
import { KpiTile } from "./KpiTile";
import { SegmentedControl } from "./SegmentedControl";

// jsdom has no ResizeObserver; the segmented control measures its thumb with one.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

afterEach(cleanup);

describe("<Chip>", () => {
  it("is a plain button until `pressed` is given, then a toggle with its count", () => {
    const [on, setOn] = createSignal(false);
    render(() => (
      <>
        <Chip>Add tests</Chip>
        <Chip size="sm" pressed={on()} count={3} onClick={() => setOn(!on())}>Needs you</Chip>
        <Chip dashed>All prompts</Chip>
      </>
    ));
    expect(screen.getByRole("button", { name: "Add tests" }).hasAttribute("aria-pressed")).toBe(false);
    const toggle = screen.getByRole("button", { name: /Needs you/ });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.textContent).toBe("Needs you3");
    expect(toggle.getAttribute("data-size")).toBe("sm");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "All prompts" }).hasAttribute("data-dashed")).toBe(true);
  });
});

describe("<ChoiceCard>", () => {
  it("wraps a native tick box: the card is the label and reports the change", () => {
    const change = vi.fn();
    render(() => <ChoiceCard type="checkbox" checked={false} onChange={change} title="admin" description="feature-light-design" mono />);
    const box = screen.getByRole("checkbox", { name: /admin/ });
    fireEvent.click(box);
    expect(change).toHaveBeenCalledWith(true);
    expect(document.querySelector(".ui-choice__desc")?.hasAttribute("data-mono")).toBe(true);
  });

  it("marks the chosen radio of a group and keeps a disabled one out", () => {
    const change = vi.fn();
    render(() => (
      <div role="radiogroup" aria-label="Freedom">
        <ChoiceCard type="radio" name="preset" value="careful" checked={false} onChange={change} title="Careful" description="Asks first" />
        <ChoiceCard type="radio" name="preset" value="balanced" checked onChange={change} title="Balanced" />
        <ChoiceCard type="radio" name="preset" value="auto" checked={false} disabled onChange={change} title="Autonomous" />
      </div>
    ));
    expect((screen.getByRole("radio", { name: /Balanced/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("radio", { name: /Balanced/ }).closest(".ui-choice")?.hasAttribute("data-checked")).toBe(true);
    expect((screen.getByRole("radio", { name: /Autonomous/ }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /Careful/ }));
    expect(change).toHaveBeenCalledWith(true);
  });

  it("draws a setting row as a switch", () => {
    render(() => <ChoiceCard type="switch" checked onChange={() => {}} title="Ultracode" description="Uses more of your plan." />);
    expect(screen.getByRole("switch", { name: /Ultracode/ })).toBeTruthy();
  });
});

describe("<SegmentedControl> variants", () => {
  it("carries the size and the accent variant", () => {
    render(() => <SegmentedControl aria-label="Mode" size="lg" variant="accent" value="agent" onChange={() => {}} options={[{ value: "agent", label: "Agent" }, { value: "editor", label: "Editor" }]} />);
    const group = screen.getByRole("radiogroup", { name: "Mode" });
    expect(group.getAttribute("data-size")).toBe("lg");
    expect(group.getAttribute("data-variant")).toBe("accent");
    expect(screen.getByRole("radio", { name: "Agent" }).getAttribute("aria-checked")).toBe("true");
  });
});

describe("<KpiTile> as a number tile", () => {
  it("shows a toned reason line and a labelled bar", () => {
    render(() => <KpiTile label="Weekly plan used" value="42%" tone="warn" hint="Resets on Monday" hintTone="warn" meter={42} meterLabel="42 percent used" />);
    const tile = screen.getByRole("group");
    expect(tile.getAttribute("data-tone")).toBe("warn");
    expect(tile.querySelector(".ui-kpi__hint")?.getAttribute("data-tone")).toBe("warn");
    const bar = screen.getByRole("progressbar", { name: "42 percent used" });
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
  });
});
