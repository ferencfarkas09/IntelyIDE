import { cleanup, configure, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async (orig) => {
  const mod = await orig<typeof import("../../ipc")>();
  const { createMockIpc } = await import("../../ipc/mock");
  return { ...mod, ipc: createMockIpc("normal", { delayScale: 0 }) };
});

import { ipc } from "../../ipc";
import { installDomStubs } from "../../store/testing-u2";
import WeakWriterControls from "./WeakWriterControls";

configure({ asyncUtilTimeout: 15000 });
vi.setConfig({ testTimeout: 30000 });
installDomStubs();
afterEach(cleanup);

describe("<WeakWriterControls> (Settings > Safety)", () => {
  it("says so when no experimental provider is switched on and confirmed", async () => {
    render(() => <WeakWriterControls />);
    expect(await screen.findByText("No experimental provider is switched on and confirmed.")).toBeTruthy();
  });

  it("is off by default and turns on only after the provider id is typed exactly; turning it off needs nothing", async () => {
    await ipc.providers.setExperimental(true);
    await ipc.providers.setEnabled("codex", true);
    await ipc.providers.detect();
    await ipc.providers.confirmLaunch("codex", "/usr/local/bin/codex", ["app-server"]);
    render(() => <WeakWriterControls />);
    // rows are rebuilt with every answer of the backend, so the switch is looked up again each time
    const sw = () => screen.getByRole("switch", { name: "Allow Codex to change files" });
    await screen.findByRole("switch", { name: "Allow Codex to change files" });
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Enforcement for roles that change files: Weak.")).toBeTruthy();
    fireEvent.click(sw());
    const dialog = within(await screen.findByRole("alertdialog"));
    const allow = dialog.getByRole("button", { name: "Allow writing" }) as HTMLButtonElement;
    expect(allow.disabled).toBe(true);
    fireEvent.input(dialog.getByLabelText("Confirmation text"), { target: { value: "Codex" } });
    expect(allow.disabled).toBe(true);
    fireEvent.input(dialog.getByLabelText("Confirmation text"), { target: { value: "codex" } });
    expect(allow.disabled).toBe(false);
    fireEvent.click(allow);
    await waitFor(() => expect(sw().getAttribute("aria-checked")).toBe("true"));
    expect((await ipc.providers.list()).find((p) => p.id === "codex")?.allowWeakWriter).toBe(true);
    fireEvent.click(sw());
    await waitFor(() => expect(sw().getAttribute("aria-checked")).toBe("false"));
    expect((await ipc.providers.list()).find((p) => p.id === "codex")?.allowWeakWriter).toBe(false);
  });
});
