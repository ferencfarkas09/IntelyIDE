import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NewRunSlotContext } from "../../platform/newRunSlots";
import type { PermissionMode } from "../../store/agent-types";
import { MODE_ORDER } from "../../store/permissionModes";
import { installDomStubs } from "../../store/testing-u2";
import { checksEnabled, secretGuardEnabled, setChecksEnabled, setSecretGuardEnabled } from "../checks/toggle";
import { modeOf, presetBlocker, presetOf, PRESETS } from "./logic";
import PresetBar from "./PresetBar";

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

  it("is blocked where the provider or its gate says no", () => {
    expect(presetBlocker("autonomous", ["readOnly", "ask", "edit"], {})).toBe("unsupported");
    expect(presetBlocker("balanced", ["ask", "edit"], { edit: "Weak enforcement" })).toBe("Weak enforcement");
    expect(presetBlocker("careful", [], {})).toBeUndefined();
  });
});

describe("the preset bar", () => {
  const ctxWith = (mode: PermissionMode, supported: PermissionMode[] = ["readOnly", "ask", "edit", "automatic", "bypass"]) => {
    const [m, setM] = createSignal<PermissionMode>(mode);
    const pickMode = vi.fn((x: PermissionMode) => setM(x));
    const ctx: NewRunSlotContext = { prompt: () => "", setPrompt: () => {}, repoIds: () => [], permission: m, pickMode, supported: () => supported, unavailable: () => ({}), disabled: () => false };
    return { ctx, pickMode };
  };

  it("picks the mode through the dialog's own path and describes it in plain words", () => {
    const { ctx, pickMode } = ctxWith("edit");
    render(() => <PresetBar ctx={ctx} />);
    expect(screen.getByRole("radio", { name: "Balanced" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/Changes files on its own/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Careful" }));
    expect(pickMode).toHaveBeenCalledWith("ask");
    expect(screen.getByText(/Asks you before every file change/)).toBeTruthy();
  });

  it("shows no preset for Bypass and never picks Bypass itself", () => {
    const { ctx, pickMode } = ctxWith("bypass", ["ask", "edit"]);
    render(() => <PresetBar ctx={ctx} />);
    expect(screen.getAllByRole("radio").every((r) => r.getAttribute("aria-checked") === "false")).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Autonomous" }));
    expect(pickMode).not.toHaveBeenCalled();
  });

  it("offers the secret check while it is off and turns on both switches", () => {
    setChecksEnabled(false);
    const { ctx } = ctxWith("edit");
    render(() => <PresetBar ctx={ctx} />);
    fireEvent.click(screen.getByRole("button", { name: "Turn it on" }));
    expect(checksEnabled() && secretGuardEnabled()).toBe(true);
    expect(screen.queryByRole("button", { name: "Turn it on" })).toBeNull();
    setChecksEnabled(false);
    setSecretGuardEnabled(true);
  });
});
