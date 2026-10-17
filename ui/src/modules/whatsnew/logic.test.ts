import { describe, expect, it } from "vitest";
import { compareVersions, decide, MAX_RELEASES, pick, releasesToShow, type DecisionInput, type Release } from "./logic";

const release = (version: string): Release => ({ version, date: "2026-10-01", headline: { en: `H ${version}`, hu: `F ${version}` }, notes: [] });
const ALL = ["1.7.0", "1.6.0", "1.5.1", "1.5.0", "1.4.1", "1.4.0"].map(release);

describe("compareVersions", () => {
  it("compares numbers, not text", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.5.1", "1.5.0")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.6.0", "1.6.0")).toBe(0);
    expect(compareVersions("1.5.0", "1.6.0")).toBeLessThan(0);
  });

  it("counts anything that is not X.Y.Z as 0.0.0", () => {
    expect(compareVersions("dev", "0.0.0")).toBe(0);
    expect(compareVersions("1.2.3-rc.1", "0.0.1")).toBeLessThan(0);
  });
});

describe("pick", () => {
  it("reads Hungarian for any hu locale and English for everything else", () => {
    const text = { en: "Fixed", hu: "Javítva" };
    expect(pick(text, "hu")).toBe("Javítva");
    expect(pick(text, "hu-HU")).toBe("Javítva");
    expect(pick(text, "en")).toBe("Fixed");
    expect(pick(text, "de")).toBe("Fixed");
  });
});

describe("releasesToShow", () => {
  const versions = (seen: string | undefined, current: string) => releasesToShow(ALL, seen, current).map((r) => r.version);

  it("lists what came in since the last window, newest first", () => {
    expect(versions("1.6.0", "1.7.0")).toEqual(["1.7.0"]);
    expect(versions("1.5.0", "1.7.0")).toEqual(["1.7.0", "1.6.0", "1.5.1"]);
  });

  it("lists only the running release without a last-seen version", () => {
    expect(versions(undefined, "1.7.0")).toEqual(["1.7.0"]);
  });

  it("never lists a release newer than the running one", () => {
    expect(versions("1.4.0", "1.5.1")).toEqual(["1.5.1", "1.5.0", "1.4.1"]);
  });

  it("stops at MAX_RELEASES when somebody skipped many", () => {
    expect(versions("1.0.0", "1.7.0")).toHaveLength(MAX_RELEASES);
    expect(versions("1.0.0", "1.7.0")[0]).toBe("1.7.0");
  });

  it("lists nothing when the running version has no notes after the last seen one", () => {
    expect(versions("1.7.0", "1.7.0")).toEqual([]);
    expect(versions("1.7.0", "1.7.1")).toEqual([]);
  });
});

describe("decide", () => {
  const base: DecisionInput = { seen: "1.6.0", current: "1.7.0", freshInstall: false, jailOff: true, news: 1 };
  const verdict = (over: Partial<DecisionInput>) => decide({ ...base, ...over });

  it("shows the window after an update that has something to tell", () => {
    expect(verdict({})).toBe("show");
    expect(verdict({ seen: undefined })).toBe("show"); // an app that was updated from a build without this window
  });

  it("does nothing when the version is the one already seen", () => {
    expect(verdict({ seen: "1.7.0", news: 0 })).toBe("none");
  });

  it("only writes the version down on a first start, whatever the notes hold", () => {
    expect(verdict({ seen: undefined, freshInstall: true })).toBe("remember");
  });

  it("does not take a first start with a seen version for a fresh install", () => {
    expect(verdict({ freshInstall: true })).toBe("show");
  });

  it("writes the version down after a downgrade and after an update without notes", () => {
    expect(verdict({ seen: "1.8.0" })).toBe("remember");
    expect(verdict({ news: 0 })).toBe("remember");
  });

  it("stays out of a browser run, a dev run without a version, and the read-only and test jails", () => {
    expect(verdict({ current: undefined })).toBe("none");
    expect(verdict({ jailOff: false })).toBe("none");
  });
});
