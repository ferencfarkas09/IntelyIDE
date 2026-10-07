import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { App } from "./App";
import { installLayoutStubs } from "./testLayout";

beforeAll(installLayoutStubs);
afterEach(cleanup);

describe("App", () => {
  it("mounts the shell with the title bar, rail, tool window and status bar", async () => {
    render(() => <App />);
    expect(screen.getByTestId("shell")).not.toBeNull();
    expect(screen.getByRole("radio", { name: "Editor" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Agent" }).getAttribute("aria-disabled")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Tool windows" })).not.toBeNull();
    expect(screen.getByRole("contentinfo", { name: "Status" })).not.toBeNull();
    await screen.findByText("Environment ready", {}, { timeout: 3000 });
  });
});
