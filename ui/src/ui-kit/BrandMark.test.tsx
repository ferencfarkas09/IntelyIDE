import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { BrandMark } from "./BrandMark";

const gradientIds = (root: ParentNode) => [...root.querySelectorAll("linearGradient")].map((g) => g.id);

describe("<BrandMark>", () => {
  afterEach(cleanup);

  it("uses the simplified cut up to 32 px and the full mark above", () => {
    const { container } = render(() => (
      <>
        <BrandMark size={16} />
        <BrandMark size={32} />
        <BrandMark size={64} />
      </>
    ));
    const marks = [...container.querySelectorAll("svg")];
    expect(marks.map((m) => m.getAttribute("data-variant"))).toEqual(["small", "small", "mark"]);
    expect(marks[0].querySelector("path[d^='M0 -1']")).toBeNull();
    expect(marks[2].querySelector("path[d^='M0 -1']")).not.toBeNull();
  });

  it("gives every instance its own gradient ids", () => {
    const { container } = render(() => (
      <>
        <BrandMark size={20} />
        <BrandMark size={20} />
        <BrandMark variant="lockup" size={48} />
      </>
    ));
    const ids = gradientIds(container);
    expect(ids.length).toBe(3 + 3 + 3 + 1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is decorative unless it has a label, and can pin the palette", () => {
    render(() => (
      <>
        <BrandMark size={20} />
        <BrandMark size={20} label="IntelyIDE" theme="light" />
      </>
    ));
    expect(screen.getByRole("img", { name: "IntelyIDE" }).getAttribute("data-brand-theme")).toBe("light");
    expect(screen.getAllByRole("img").length).toBe(1);
  });

  it("sizes lockups by height and keeps the outlined wordmark (no text nodes)", () => {
    const { container } = render(() => <BrandMark variant="stacked" size={120} label="IntelyIDE" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("height")).toBe("120");
    expect(Number(svg.getAttribute("width"))).toBeGreaterThan(0);
    expect(svg.querySelector("text")).toBeNull();
  });
});
