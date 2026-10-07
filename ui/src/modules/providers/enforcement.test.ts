import type { EnforcementChip } from "@intely/protocol";
import { describe, expect, it } from "vitest";
import type { ProviderEnforcement } from "../../ipc/providers";
import { chipFor, roleGate, roleKind, shownTier, tierFor } from "./enforcement";
import { capSummary, CAP_ROWS } from "./caps";
import { permissionMeaning, providerName } from "./catalog";
import { DEFAULT_CAPS, capsOfProvider } from "../../ipc/providerCaps";

const run = (suites: Record<string, "pass" | "fail" | "notRun">): EnforcementChip["run"] => ({
  key: { adapter: "x", authMode: "subscription", roleMode: "edit", cliVersion: "1" },
  suites: suites as never,
  layersProven: [],
  at: 0,
});

describe("shownTier", () => {
  it("is weak with nothing recorded", () => {
    expect(shownTier(undefined)).toMatchObject({ tier: "weak", results: [], downgraded: false });
    expect(shownTier({ tier: "weak" })).toMatchObject({ tier: "weak", downgraded: false });
  });

  it("keeps a tier only when a recorded run with a passing suite stands behind it", () => {
    expect(shownTier({ tier: "bestEffort", run: run({ s0: "pass", s1: "pass", s2: "notRun" }) })).toMatchObject({ tier: "bestEffort", passed: ["s0", "s1"], downgraded: false });
    // A claimed tier without a run, or with no passing suite, is shown as weak.
    expect(shownTier({ tier: "strong" })).toMatchObject({ tier: "weak", downgraded: true });
    expect(shownTier({ tier: "strong", run: run({ s0: "fail", s1: "notRun" }) })).toMatchObject({ tier: "weak", downgraded: true });
  });

  it("lists suites in suite order with their results", () => {
    const s = shownTier({ tier: "bestEffort", run: run({ s2: "fail", s0: "pass" }) });
    expect(s.results.map((r) => [r.suite, r.result])).toEqual([["s0", "pass"], ["s2", "fail"]]);
  });
});

describe("roleGate", () => {
  it("lets read-only roles run anywhere, with a caution while weak", () => {
    expect(roleGate("gemini", "Gemini", "readOnly", "weak")).toMatchObject({ ok: true });
    expect(roleGate("gemini", "Gemini", "readOnly", "weak").caution).toMatch(/read-only/);
    expect(roleGate("gemini", "Gemini", "readOnly", "strong").caution).toBeUndefined();
  });

  it("refuses write and ask roles on a provider other than Claude below strong", () => {
    for (const mode of ["edit", "ask"] as const) {
      expect(roleGate("codex", "Codex", mode, "weak")).toMatchObject({ ok: false });
      expect(roleGate("codex", "Codex", mode, "bestEffort")).toMatchObject({ ok: false });
      expect(roleGate("codex", "Codex", mode, "strong")).toEqual({ ok: true });
      expect(roleGate("codex", "Codex", mode, "structural")).toEqual({ ok: true });
    }
    expect(roleGate("codex", "Codex", "edit", "weak").reason).toContain("Codex is Weak");
  });

  it("keeps Claude's alpha behaviour: allowed, with a caution below strong", () => {
    expect(roleGate("claude", "Claude", "edit", "bestEffort")).toMatchObject({ ok: true });
    expect(roleGate("claude", "Claude", "edit", "bestEffort").caution).toMatch(/Rewind/);
    expect(roleGate("claude", "Claude", "edit", "strong")).toEqual({ ok: true });
  });

  it("judges ask like edit", () => {
    expect(roleKind("ask")).toBe("write");
    expect(roleKind("readOnly")).toBe("readOnly");
  });
});

describe("lookup", () => {
  const list: ProviderEnforcement[] = [{ provider: "claude", roleMode: "write", chip: { tier: "bestEffort", run: run({ s0: "pass" }) } }];
  it("finds the chip per provider and kind; a missing one is weak", () => {
    expect(chipFor(list, "claude", "write")?.tier).toBe("bestEffort");
    expect(chipFor(list, "claude", "readOnly")).toBeUndefined();
    expect(tierFor(list, "claude", "readOnly").tier).toBe("weak");
    expect(tierFor(list, "codex", "write").tier).toBe("weak");
  });
});

describe("capability data", () => {
  it("every provider has all 13 capabilities", () => {
    for (const [id, caps] of Object.entries(DEFAULT_CAPS)) for (const row of CAP_ROWS) expect(caps[row.key], `${id}.${row.key}`).toBeTruthy();
    expect(CAP_ROWS).toHaveLength(13);
  });

  it("unknown providers get the conservative generic ACP row", () => {
    expect(capsOfProvider("somethingnew").permissions.cap).toBe("partial");
    expect(capsOfProvider("somethingnew").sandbox.cap).toBe("no");
  });

  it("the summary names what the UI will hide or flag", () => {
    expect(capSummary(DEFAULT_CAPS.ollama)).toContain("Effort shows as n/a");
    expect(capSummary(DEFAULT_CAPS.gemini)).toContain("may not apply");
    expect(capSummary(DEFAULT_CAPS.claude)).not.toContain("Cost shows as n/a");
    expect(capSummary(DEFAULT_CAPS.copilot)).toContain("Attachments are not accepted");
  });

  it("explains what a mode means per provider: Automatic and Bypass exist on Claude and the mock only", () => {
    expect(permissionMeaning("gemini", "readOnly")).toBe("--approval-mode plan");
    expect(permissionMeaning("opencode", "readOnly")).toMatch(/denied/);
    expect(permissionMeaning("claude", "automatic")).toMatch(/^Works without asking/);
    expect(permissionMeaning("mock", "bypass")).toMatch(/^No prompts and no folder boundary/);
    expect(permissionMeaning("codex", "automatic")).toMatch(/refused/);
    expect(permissionMeaning("gemini", "bypass")).toMatch(/refused/);
    expect(providerName("copilot")).toBe("GitHub Copilot");
    expect(providerName("zzz")).toBe("zzz");
  });
});
