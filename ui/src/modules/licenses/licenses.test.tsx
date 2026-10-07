import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { availableCommands, resetCommands } from "../../platform/commands";
import { overlays, resetOverlays } from "../../platform/overlay";
import { closeLicenses, licensesState, openLicenses } from "../../shell/licenses/open";
import { register } from "./index";

afterEach(() => {
  cleanup();
  resetCommands();
  resetOverlays();
  closeLicenses();
});

describe("licenses module", () => {
  it("registers one overlay and one command", () => {
    register();
    expect(overlays().map((o) => o.id)).toEqual(["licenses"]);
    expect(availableCommands().map((c) => c.id)).toContain("licenses.show");
  });

  it("the command opens the view and carries search keywords", () => {
    register();
    const cmd = availableCommands().find((c) => c.id === "licenses.show")!;
    expect(cmd.title).toBe("Show open-source licenses");
    expect(cmd.keywords).toEqual(expect.arrayContaining(["license", "gpl", "notices"]));
    expect(licensesState().open).toBe(false);
    void cmd.run();
    expect(licensesState()).toMatchObject({ open: true, ever: true });
  });

  it("the host renders nothing until the first open", () => {
    register();
    const Host = overlays()[0]!.component;
    const { container } = render(() => <Host />);
    expect(container.innerHTML).toBe("");
    openLicenses();
  });
});
