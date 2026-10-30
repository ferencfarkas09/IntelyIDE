import { describe, expect, it } from "vitest";
import cases from "../../../fixtures/masking/cases.json";
import { MASK, maskLocally } from "./vibeMask";

// The same cases as crates/runindex/tests/masking_fixture.rs (the app's masker), so the fallback stays in step with it.
describe("the interface's fallback masker on the shared cases", () => {
  for (const c of cases.masked) {
    it(`masks: ${c.name}`, () => {
      const out = maskLocally(c.parts.join(""));
      expect(out).not.toContain(c.secret.join(""));
      expect(out).toContain(MASK);
      expect(maskLocally(out)).toBe(out);
    });
  }

  it("leaves ordinary text alone", () => {
    for (const plain of cases.plain) expect(maskLocally(plain)).toBe(plain);
  });
});
