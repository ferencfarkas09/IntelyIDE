import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@solidjs/testing-library";
import { MODE_ORDER } from "../../store/permissionModes";
import { installDomStubs } from "../../store/testing-u2";
import { checksEnabled, secretGuardEnabled, setChecksEnabled, setSecretGuardEnabled } from "../checks/toggle";
import { ipc } from "../../ipc";
import AgentsSection from "./AgentsSection";
import { effectiveStartMode, modeOf, presetOf, PRESETS, startMode } from "./logic";
import { SecretGuardOffer } from "./SecretGuardOffer";

installDomStubs();
afterEach(cleanup);

describe("presets", () => {
  it("map onto the three working modes and never onto Plan or Bypass", () => {
    expect(PRESETS.map((p) => p.mode)).toEqual(["ask", "edit", "automatic"]);
    expect(presetOf("readOnly")).toBeUndefined();
    expect(presetOf("bypass")).toBeUndefined();
    expect(modeOf("autonomous")).toBe("automatic");
    // in policy order: a preset further right is never stricter than one on its left
    const idx = PRESETS.map((p) => MODE_ORDER.indexOf(p.mode));
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });
});

describe("the secret-check offer", () => {
  it("shows while the check is off and turns on both switches", () => {
    setChecksEnabled(false);
    render(() => <SecretGuardOffer />);
    fireEvent.click(screen.getByRole("button", { name: "Turn on Checks with the secret scan" }));
    expect(checksEnabled() && secretGuardEnabled()).toBe(true);
    expect(screen.queryByRole("button", { name: "Turn on Checks with the secret scan" })).toBeNull();
    setChecksEnabled(false);
    setSecretGuardEnabled(true);
  });
});

describe("the default of new runs", () => {
  it("is the Settings choice when there is one, else the last run's mode, never Bypass, else what the dialog falls back to", () => {
    expect(startMode({ defaultMode: "ask", lastMode: "automatic" })).toBe("ask");
    expect(startMode({ lastMode: "edit" })).toBe("edit");
    expect(startMode({ defaultMode: "bypass", lastMode: "bypass" })).toBeUndefined();
    expect(startMode({ defaultMode: "nonsense" })).toBeUndefined();
    expect(effectiveStartMode({})).toBe("automatic");
  });

  it("Settings shows the real default on a fresh install and stores its own choice apart from the last run", async () => {
    vi.spyOn(ipc.settings, "get").mockResolvedValue({});
    const set = vi.spyOn(ipc.settings, "set").mockResolvedValue({});
    render(() => <AgentsSection />);
    await waitFor(() => expect(screen.getAllByRole("radio", { name: "Autonomous" })[0].getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(screen.getAllByRole("radio", { name: "Careful" })[0]);
    expect(set).toHaveBeenCalledWith("runs", { defaultMode: "ask" });
    vi.restoreAllMocks();
  });
});
