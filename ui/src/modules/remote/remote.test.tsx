import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import type { MockRemoteSim } from "../../ipc/mock/remote";
import type { RemoteIpc } from "../../ipc/remote";
import { availableCommands, resetCommands } from "../../platform/commands";
import { resetSettings, settingsSections } from "../../platform/settings";
import { resetStatusItems, statusItems } from "../../platform/statusbar";
import { installDomStubs } from "../../store/testing-u2";
import { register } from "./index";
import RemoteSection from "./RemoteSection";
import { auditLabel, deviceLine, pairingLink, statusChipText } from "./logic";
import { remoteView, resetRemoteState } from "./state";

installDomStubs();
const remote = ipc.remote as RemoteIpc & { sim: MockRemoteSim };

afterEach(async () => {
  cleanup();
  resetCommands();
  resetSettings();
  resetStatusItems();
  vi.restoreAllMocks();
  await remote.disable().catch(() => {});
  resetRemoteState();
});

describe("remote register()", () => {
  it("registers the section, the chip and the commands without any IPC, and the chip is hidden while Remote is off", () => {
    const spies = [vi.spyOn(remote, "status"), vi.spyOn(remote, "onEvent"), vi.spyOn(remote, "enable")];
    register();
    expect(settingsSections().map((s) => s.id)).toContain("remote");
    expect(availableCommands().map((c) => c.id)).toContain("remote.open");
    expect(availableCommands().map((c) => c.id)).not.toContain("remote.kill"); // nothing to kill while off
    expect(statusItems("right").map((i) => i.id)).not.toContain("remote-chip");
    spies.forEach((s) => expect(s).not.toHaveBeenCalled());
  });
});

describe("logic", () => {
  it("builds the link a phone opens and short labels", () => {
    expect(pairingLink("ws://127.0.0.1:8787", "#p=a,b,c,d")).toBe("http://127.0.0.1:8787/#p=a,b,c,d");
    expect(pairingLink("wss://relay.example.com/", "#p=x")).toBe("https://relay.example.com/#p=x");
    expect(auditLabel("pairing.codeProven")).toBe("Pairing code proven");
    expect(statusChipText("online", 1)).toBe("Remote · 1 phone");
    expect(statusChipText("online", 3)).toBe("Remote · 3 phones");
    expect(deviceLine({ id: "d", name: "x", capability: "reply", reauthRequired: true, hasPasskey: false, connected: false, createdAt: 0, lastSeenAt: 0 }, 5 * 60_000)).toContain("needs a passkey check");
  });
});

describe("<RemoteSection>", () => {
  it("is off by default, switches on, pairs a phone through the six-digit comparison (view only) and revokes it", async () => {
    render(() => <RemoteSection />);
    const sw = await screen.findByRole("switch", { name: "Enable Remote" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect((screen.getByTestId("pair") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("No phone is paired.")).toBeTruthy();
    expect(screen.getByText("Blocked")).toBeTruthy(); // Claude's own Remote Control

    fireEvent.click(sw);
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
    expect(remoteView()?.state).toBe("online");

    await waitFor(() => expect((screen.getByTestId("pair") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("pair"));
    expect((await screen.findByTestId("manual-code")).textContent).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{1,5})+$/);
    expect(document.querySelector("svg.remote-qr path")).toBeTruthy();
    expect(screen.getByTestId("countdown").textContent).toMatch(/Valid for \d+ s/);

    const code = remote.sim.phoneArrives("Ferenc's iPhone");
    expect((await screen.findByTestId("sas")).textContent?.replace(/\s/g, "")).toBe(code);
    fireEvent.click(screen.getByRole("button", { name: /Codes match/ }));
    const rows = await screen.findAllByTestId("device-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Ferenc's iPhone");
    expect(rows[0]!.textContent).toContain("View only"); // the default for a new device
    expect(remoteView()!.devices[0]!.capability).toBe("view");

    fireEvent.click(screen.getByRole("button", { name: "Revoke Ferenc's iPhone" }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke now" }));
    await waitFor(() => expect(screen.queryAllByTestId("device-row")).toHaveLength(0));
  });

  it("'Codes do not match' registers nothing", async () => {
    await remote.enable();
    render(() => <RemoteSection />);
    fireEvent.click(await screen.findByTestId("pair"));
    await screen.findByTestId("manual-code");
    remote.sim.phoneArrives("Stranger");
    await screen.findByTestId("sas");
    fireEvent.click(screen.getByRole("button", { name: "Codes do not match" }));
    await waitFor(() => expect(screen.queryByTestId("sas")).toBeNull());
    expect((await remote.status()).devices).toEqual([]);
  });

  it("the kill switch switches Remote off at once and panic revokes everything after a confirmation", async () => {
    await remote.enable();
    await remote.pairStart();
    remote.sim.phoneArrives("Phone");
    await remote.pairConfirm(true);
    render(() => <RemoteSection />);
    await screen.findAllByTestId("device-row");
    fireEvent.click(screen.getByTestId("kill"));
    await waitFor(() => expect(remoteView()?.state).toBe("off"));
    expect((await remote.status()).devices.length).toBe(1); // kill keeps the pairing

    await remote.enable();
    vi.spyOn(globalThis, "confirm").mockReturnValueOnce(false);
    fireEvent.click(await screen.findByTestId("panic"));
    expect((await remote.status()).devices.length).toBe(1); // declined: nothing happened
    vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByTestId("panic"));
    await waitFor(async () => expect((await remote.status()).devices).toEqual([]));
    expect(remoteView()?.state).toBe("off");
  });

  it("shows the audit trail on demand", async () => {
    await remote.enable();
    render(() => <RemoteSection />);
    fireEvent.click(await screen.findByTestId("audit-toggle"));
    expect(screen.getByTestId("audit").textContent).toContain("Remote started");
  });
});
