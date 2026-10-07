import { describe, expect, it } from "vitest";
import { AFTER_PLAN, effectiveMode, exposureOf, isUnattended, MODE_META, MODE_ORDER, modeErrorText, strictness } from "./modes";
import { PERMISSION_LABEL } from "./format";
import { t } from "../../i18n";

describe("run modes", () => {
  it("orders the five modes from the strictest to the loosest, and Plan is the strictest", () => {
    expect([...MODE_ORDER]).toEqual(["readOnly", "ask", "edit", "automatic", "bypass"]);
    expect(MODE_ORDER.map(strictness)).toEqual([0, 1, 2, 3, 4]);
    expect(Object.keys(MODE_META).sort()).toEqual([...MODE_ORDER].sort());
  });

  it("knows which modes never ask, and which a plan can continue in", () => {
    expect(MODE_ORDER.filter(isUnattended)).toEqual(["automatic", "bypass"]);
    expect([...AFTER_PLAN]).toEqual(["ask", "edit", "automatic"]);
  });

  it("prefers what the session reported over what the host recorded", () => {
    expect(effectiveMode({ permission: "ask" })).toBe("ask");
    expect(effectiveMode({ permission: "ask", effective: null })).toBe("ask");
    expect(effectiveMode({ permission: "ask", effective: { permission: "bypass" } })).toBe("bypass");
  });

  it("names the five modes in the user's words, one table for every chip and fact", () => {
    expect(MODE_ORDER.map((m) => PERMISSION_LABEL[m])).toEqual(["Plan / read only", "Ask", "Edit automatically", "Automatic", "Bypass"]);
    expect(MODE_ORDER.map((m) => t(MODE_META[m].label))).toEqual(MODE_ORDER.map((m) => PERMISSION_LABEL[m]));
    expect(MODE_META.bypass.tone).toBe("danger");
  });

  it("totals what the MCP servers would run unasked, and which of them keep a secret", () => {
    expect(exposureOf(undefined)).toEqual({ count: 0, names: "", secretNames: "" });
    expect(exposureOf([{ name: "a", exposed: 2, hasSecretEnv: false }, { name: "b", exposed: 0, hasSecretEnv: true }, { name: "c", exposed: 1, hasSecretEnv: true }])).toEqual({ count: 3, names: "a, c", secretNames: "b, c" });
  });

  it("words the host's mode errors, and falls back to its own message", () => {
    expect(modeErrorText("writeLease")).toBe("Another run is writing to this repository. Wait for it, or pick Ask.");
    expect(modeErrorText("modeChanged")).toBe("The rules changed while this was waiting, so the request was withdrawn.");
    expect(modeErrorText("zzz", "own message")).toBe("own message");
    expect(modeErrorText(undefined)).toBe("That did not go through.");
  });
});
