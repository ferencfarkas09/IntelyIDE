import { describe, expect, it } from "vitest";
import type { ProviderInfo } from "../../ipc/providers";
import { baseUrlProblem, cardChip, enforcementChip, replaceProvider, sdkIssue, SDK_SETUP_COMMANDS, secretKey, STATE_CHIP } from "./logic";

describe("provider logic", () => {
  it("has a chip for every state and a Keychain key per provider", () => {
    expect(Object.keys(STATE_CHIP)).toHaveLength(11);
    expect(secretKey("openai")).toBe("providers.openai:default");
  });

  it("never claims a tier: nothing recorded is Weak, and the detail names the CLI version", () => {
    const chip = enforcementChip({ id: "codex", name: "Codex", cli: { bin: "codex", version: "0.146.0" } }, []);
    expect(chip).toMatchObject({ label: "Enforcement: Weak", tone: "danger" });
    expect(chip.detail).toContain("Codex 0.146.0");
    expect(chip.detail).toContain("read-only");
  });

  it("accepts https and local http endpoints only", () => {
    expect(baseUrlProblem("")).toBeNull();
    expect(baseUrlProblem("https://api.example.com/v1")).toBeNull();
    expect(baseUrlProblem("http://127.0.0.1:11434")).toBeNull();
    expect(baseUrlProblem("http://localhost:8080")).toBeNull();
    expect(baseUrlProblem("http://api.example.com")).toBe("insecure");
    expect(baseUrlProblem("ftp://x.test")).toBe("scheme");
    expect(baseUrlProblem("not a url")).toBe("invalid");
  });

  it("replaces one provider and keeps the order", () => {
    const a = { id: "a", name: "A" } as ProviderInfo;
    const b = { id: "b", name: "B" } as ProviderInfo;
    expect(replaceProvider([a, b], { ...b, name: "B2" }).map((p) => p.name)).toEqual(["A", "B2"]);
  });
});

describe("SDK problems from Detection.message", () => {
  const claude = (message: string | null, state: ProviderInfo["state"] = "ready") => ({ id: "claude", state, message }) as ProviderInfo;

  it("maps each stable prefix to its code and keeps the detail", () => {
    expect(sdkIssue(claude("sdk_missing: not found under ~/x"))).toEqual({ code: "sdk_missing", detail: "not found under ~/x" });
    expect(sdkIssue(claude("sdk_incompatible: 0.3.1"))?.code).toBe("sdk_incompatible");
    expect(sdkIssue(claude("sdk_unverified: hash mismatch"))?.code).toBe("sdk_unverified");
    expect(sdkIssue(claude("sdk_broken: dependency zod"))?.code).toBe("sdk_broken");
  });

  it("ignores other messages, other providers and a provider that is off or blocked", () => {
    expect(sdkIssue(claude(null))).toBeNull();
    expect(sdkIssue(claude("claude was not found on PATH", "notInstalled"))).toBeNull();
    expect(sdkIssue({ ...claude("sdk_missing: x"), id: "codex" })).toBeNull();
    expect(sdkIssue(claude("sdk_missing: x", "off"))).toBeNull();
    expect(sdkIssue(claude("sdk_missing: x", "blocked"))).toBeNull();
  });

  it("the chip says SDK, never Not installed, while the CLI exists", () => {
    expect(cardChip(claude("sdk_missing: x", "needsLogin")).label).toBe("SDK missing");
    expect(cardChip(claude("sdk_unverified: x")).label).toBe("SDK unverified");
    expect(cardChip(claude(null)).label).toBe("Ready");
  });

  it("prints lock-based commands, never a floating install", () => {
    const text = SDK_SETUP_COMMANDS.join("\n");
    expect(text).toContain("npm ci --ignore-scripts --omit=optional --prefix");
    expect(text).toContain("mkdir -m 700");
    expect(text).not.toMatch(/npm (install|i)\b|@\d/);
  });
});
