import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoleProviderCaps } from "../../ipc/roles";
import { getCommand } from "../../platform/commands";
import { settingsSections } from "../../platform/settings";
import { installDomStubs } from "../../store/testing-u2";
import { effortAfterModelChange, effortChoice, isClaudeModelId, pickBlocker, pickRequest, restoredPick, ultracodeOffered, type RunPick } from "./logic";
import RunPicker from "./RunPicker";

installDomStubs();
afterEach(() => cleanup());

const CAPS: RoleProviderCaps[] = [
  {
    provider: "claude",
    label: "Claude",
    models: [
      { id: "claude-fable-5-1", label: "Fable 5.1", effortLevels: ["low", "medium", "high", "xhigh", "max"] },
      { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", effortLevels: [] },
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5", effortLevels: ["max", "low", "high", "medium"] },
    ],
    permissionModes: ["readOnly", "edit", "ask"],
    tools: [],
  },
  { provider: "codex", label: "Codex", models: [{ id: "codex-default", label: "Codex default", effortLevels: ["low", "high"] }], permissionModes: ["readOnly"], tools: [] },
];

describe("run picker logic", () => {
  it("offers a model's own effort levels in ladder order, the whole ladder for an unknown Claude model, none for another provider's", () => {
    expect(effortChoice("claude-sonnet-5-5", CAPS, "claude")).toEqual({ levels: ["low", "medium", "high", "max"], unknownModel: false });
    expect(effortChoice("claude-haiku-4-5-20251001", CAPS, "claude")).toEqual({ levels: [], unknownModel: false });
    expect(effortChoice("claude-opus-9", CAPS, "claude")).toEqual({ levels: ["low", "medium", "high", "xhigh", "max"], unknownModel: true });
    expect(effortChoice("other-model", CAPS, "codex")).toEqual({ levels: [], unknownModel: false });
    expect(effortChoice(undefined, CAPS, "claude").levels).toEqual([]);
  });

  it("snaps a picked effort into the new model: never higher, none without effort control, unpicked stays unpicked", () => {
    expect(effortAfterModelChange("xhigh", ["low", "medium", "high", "max"])).toBe("high");
    expect(effortAfterModelChange("max", ["low", "medium", "high", "xhigh", "max"])).toBe("max");
    expect(effortAfterModelChange("high", [])).toBeUndefined();
    expect(effortAfterModelChange(undefined, ["low"])).toBeUndefined();
  });

  it("sends only what was picked; an effort the model does not take and ultracode where it is not offered are left out", () => {
    const all = ["low", "medium", "high", "xhigh", "max"] as const;
    expect(pickRequest({}, { ultracodeAllowed: true, effortLevels: all })).toEqual({});
    expect(pickRequest({ model: " claude-x-1 ", effort: "max", ultracode: true }, { ultracodeAllowed: true, effortLevels: all })).toEqual({ model: "claude-x-1", effort: "max", ultracode: true });
    expect(pickRequest({ effort: "xhigh", ultracode: true }, { ultracodeAllowed: false, effortLevels: ["low", "high"] })).toEqual({});
  });

  it("accepts any listed model and typed claude-* ids, and blocks anything else", () => {
    expect(isClaudeModelId("claude-opus-5-5[1m]")).toBe(true);
    expect(isClaudeModelId("gpt-5")).toBe(false);
    expect(isClaudeModelId("claude-x; rm -rf /")).toBe(false);
    expect(pickBlocker({}, CAPS, "claude")).toBeUndefined();
    expect(pickBlocker({ model: "" }, CAPS, "claude")).toBe("badModel");
    expect(pickBlocker({ model: "claude-next-6" }, CAPS, "claude")).toBeUndefined();
    expect(pickBlocker({ model: "claude-next-6" }, CAPS, "codex")).toBe("badModel");
    expect(pickBlocker({ model: "codex-default" }, CAPS, "codex")).toBeUndefined();
  });

  it("offers ultracode for a Claude run of one role only", () => {
    expect(ultracodeOffered("claude", false)).toBe(true);
    expect(ultracodeOffered("claude", true)).toBe(false);
    expect(ultracodeOffered("codex", false)).toBe(false);
  });

  it("restores the remembered model and effort where they still fit", () => {
    expect(restoredPick({ lastModel: "claude-sonnet-5-5", lastEffort: "xhigh" }, CAPS, "claude")).toEqual({ model: "claude-sonnet-5-5", effort: "high" });
    expect(restoredPick({ lastModel: "claude-sonnet-5-5", lastEffort: "xhigh" }, CAPS, "codex")).toEqual({ effort: "xhigh" });
    expect(restoredPick({ lastModel: null, lastEffort: "nonsense" }, CAPS, "claude")).toEqual({});
    expect(restoredPick({}, CAPS, "claude")).toEqual({});
  });
});

describe("<RunPicker>", () => {
  const mount = (provider = "claude", ultra = true, initial: RunPick = {}) => {
    const [value, setValue] = createSignal<RunPick>(initial);
    const onChange = vi.fn((next: RunPick) => setValue(next));
    render(() => <RunPicker caps={CAPS} provider={provider} defaultModel="claude-sonnet-5-5" defaultEffort="medium" value={value()} onChange={onChange} ultracodeOffered={ultra} />);
    return { value, onChange };
  };
  const select = (name: string) => screen.getByRole("combobox", { name }) as HTMLSelectElement;

  it("lists the role default, every model and Other, and every effort of the run's model", () => {
    mount();
    expect([...select("Model").options].map((o) => o.textContent)).toEqual(["Default: Sonnet 5.5", "Fable 5.1", "Haiku 4.5", "Sonnet 5.5", "Other model id..."]);
    expect([...select("Effort").options].map((o) => o.value)).toEqual(["", "low", "medium", "high", "max"]);
    expect(select("Effort").options[0].textContent).toBe("Default: Medium");
  });

  it("disables effort for a model without it and clamps the effort when the model changes", () => {
    const { value } = mount("claude", true, { effort: "max" });
    fireEvent.change(select("Model"), { target: { value: "claude-haiku-4-5-20251001" } });
    expect(value()).toEqual({ model: "claude-haiku-4-5-20251001", effort: undefined });
    expect(select("Effort").disabled).toBe(true);
    expect(screen.getByText("This model has no effort setting.")).toBeTruthy();
  });

  it("takes a typed model id, says when it is not one, and offers the whole ladder for it", () => {
    const { value } = mount();
    fireEvent.change(select("Model"), { target: { value: "other model" } });
    expect(value().model).toBe("");
    const box = screen.getByRole("textbox", { name: "Model id" });
    fireEvent.input(box, { target: { value: "gpt-5" } });
    expect(screen.getByText(/Type a Claude model id/)).toBeTruthy();
    fireEvent.input(box, { target: { value: "claude-opus-9" } });
    expect(value().model).toBe("claude-opus-9");
    expect(screen.queryByText(/Type a Claude model id/)).toBeNull();
    expect([...select("Effort").options].map((o) => o.value)).toEqual(["", "low", "medium", "high", "xhigh", "max"]);
    expect(screen.getByText(/not in the list, so every effort level is offered/)).toBeTruthy();
  });

  it("switches ultracode with its cost notice, and hides it where it is not offered", () => {
    const { value } = mount();
    expect(screen.getByText("Starts helper agents that work in parallel. Costs more.")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: /Ultracode/ }));
    expect(value().ultracode).toBe(true);
    cleanup();
    mount("codex", false);
    expect(screen.queryByRole("switch", { name: /Ultracode/ })).toBeNull();
    expect([...select("Model").options].map((o) => o.textContent)).not.toContain("Other model id...");
  });
});

describe("register", () => {
  it("adds the Settings toggle and, while it is on, the palette command", async () => {
    const { register } = await import("./index");
    register();
    expect(settingsSections().some((s) => s.id === "runpicker")).toBe(true);
    expect(getCommand("runpicker.newRun")).toBeTruthy();
  });
});
