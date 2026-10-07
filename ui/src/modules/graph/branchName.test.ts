import { describe, expect, it } from "vitest";
import { validBranchName } from "./branchName";

describe("validBranchName", () => {
  it("accepts ordinary names and refuses the git-illegal ones", () => {
    for (const ok of ["feature/loyalty", "fix-123", "release_1.2"]) expect(validBranchName(ok)).toBe(true);
    for (const bad of ["", "a b", "a..b", "/a", "a/", "a.lock", "-x", "a~1", "a:b"]) expect(validBranchName(bad)).toBe(false);
  });
});
