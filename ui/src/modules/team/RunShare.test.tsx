import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async (orig) => {
  const mod = await orig<typeof import("../../ipc")>();
  const { createMockIpc } = await import("../../ipc/mock");
  return { ...mod, ipc: createMockIpc("normal", { delayScale: 0 }) };
});

import { ipc } from "../../ipc";
import { createMockTeam, type MockTeamHandle } from "../../ipc/mock/team";
import { resetSettings } from "../../platform/settings";
import { installDomStubs } from "../../store/testing-u2";
import { HeaderShare, NewRunShare } from "./RunShare";
import { resetTeam } from "./store";
import TeamSection from "./TeamSection";

installDomStubs();
vi.setConfig({ testTimeout: 30000 });

let mock: MockTeamHandle;
const install = (preset: "off" | "on") => {
  mock = createMockTeam({ preset });
  (ipc as { team: unknown }).team = mock;
};
beforeEach(() => resetTeam());
afterEach(() => {
  cleanup();
  resetSettings();
  vi.restoreAllMocks();
});

describe("the New run toggle", () => {
  it("is not there outside a team", async () => {
    install("off");
    render(() => <NewRunShare checked onChange={() => {}} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("newrun-share")).toBeNull();
  });

  it("switches a run off", async () => {
    install("on");
    const [on, setOn] = createSignal(true);
    render(() => <NewRunShare checked={on()} onChange={setOn} />);
    const sw = await screen.findByRole("switch", { name: /Share this run/ });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    expect(on()).toBe(false);
    await screen.findByText("This run stays private.");
  });
});

describe("the run header toggle", () => {
  it("appears only when the run's project is shared and withdraws the run when switched off", async () => {
    install("on");
    const spy = vi.spyOn(mock, "runShare");
    render(() => <HeaderShare runId="r1" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("header-share")).toBeNull(); // no project is shared yet
    cleanup();
    await mock.setShare("0a1b2c3d4e5f60718293a4b5c6d7e8f9", true);
    render(() => <HeaderShare runId="r1" />);
    const sw = await screen.findByRole("switch", { name: "Shared with the team" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    await waitFor(() => expect(spy).toHaveBeenCalledWith("r1", false));
    expect(screen.getByRole("switch", { name: "Shared with the team" }).getAttribute("aria-checked")).toBe("false");
  });
});

describe("Settings > Team shared projects", () => {
  it("lists the open projects, switches one on and cannot share a folder without an origin", async () => {
    install("on");
    const spy = vi.spyOn(mock, "setShare");
    render(() => <TeamSection />);
    const list = await screen.findByRole("list", { name: "Shared projects" });
    const widgets = await screen.findByRole("switch", { name: "Share widgets with the team" });
    expect(widgets.getAttribute("aria-checked")).toBe("false");
    const scratch = screen.getByRole("switch", { name: "Share scratch with the team" }) as HTMLButtonElement;
    expect(scratch.disabled).toBe(true);
    expect(list.textContent).toMatch(/No git origin/);
    fireEvent.click(widgets);
    await waitFor(() => expect(spy).toHaveBeenCalledWith("0a1b2c3d4e5f60718293a4b5c6d7e8f9", true));
    expect(screen.getByRole("switch", { name: "Share widgets with the team" }).getAttribute("aria-checked")).toBe("true");
  });
});
