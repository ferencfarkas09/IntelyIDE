import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { Pill } from "./Badge";

describe("<Pill>", () => {
  afterEach(cleanup);

  it("follows its props: the accessible name, title and tone change with the branch", () => {
    const [branch, setBranch] = createSignal("sandbox");
    render(() => <Pill onClick={() => undefined} aria-label={`backend, branch ${branch()}`} title={branch()} tone={branch() === "main" ? "warn" : "neutral"}>{branch()}</Pill>);
    expect(screen.getByRole("button", { name: "backend, branch sandbox" }).getAttribute("title")).toBe("sandbox");
    setBranch("main");
    const pill = screen.getByRole("button", { name: "backend, branch main" });
    expect(pill.getAttribute("title")).toBe("main");
    expect(pill.getAttribute("data-tone")).toBe("warn");
  });
});
