import { describe, expect, it } from "vitest";
import changelog from "../../../../CHANGELOG.md?raw";
import pkg from "../../../package.json";
import { compareVersions, RELEASES } from "./logic";

describe("the release notes", () => {
  it("are listed newest first, one per version, with real dates", () => {
    const versions = RELEASES.map((r) => r.version);
    for (const v of versions) expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    for (let i = 1; i < versions.length; i++) expect(compareVersions(versions[i - 1], versions[i])).toBeGreaterThan(0);
    for (const r of RELEASES) expect(Number.isNaN(Date.parse(`${r.date}T12:00:00Z`))).toBe(false);
  });

  it("have the running version at the top: a release is not finished until its notes are written", () => {
    expect(RELEASES[0].version).toBe(pkg.version);
  });

  it("have every version in the changelog, and every note in both languages", () => {
    for (const r of RELEASES) {
      expect(changelog, `CHANGELOG.md has no section for ${r.version}`).toMatch(new RegExp(`^## \\[${r.version.replace(/\./g, "\\.")}\\]`, "m"));
      for (const text of [r.headline, ...r.notes.flatMap((n) => [n.title, n.text])]) {
        expect(text.en.trim(), `${r.version}: empty English text`).not.toBe("");
        expect(text.hu.trim(), `${r.version}: empty Hungarian text`).not.toBe("");
      }
      expect(r.notes.length, `${r.version} has no notes`).toBeGreaterThan(0);
      for (const n of r.notes) expect(["new", "improved", "fixed"]).toContain(n.kind);
    }
  });
});
