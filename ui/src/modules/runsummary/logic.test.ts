import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../../i18n";
import { fixtureDigest } from "./api";
import { bullets, checkLines, chipText, explainPrompt, isFinished, MAX_BULLETS, riskLines, scriptRepos } from "./logic";
import type { RunDigest } from "./types";

afterEach(() => setLocale("en"));

const empty = (over: Partial<RunDigest> = {}): RunDigest => ({
  version: 1, runId: "r", title: "t", status: "done", startedMs: 0, endedMs: 0, generatedMs: 0, fingerprint: { size: 0, mtimeMs: 0 },
  fileCount: 0, created: 0, modified: 0, deleted: 0, additions: 0, deletions: 0, groups: [], repos: [], commands: [], commandCount: 0,
  decisions: [], checks: [], risks: [], failureCount: 0, failures: [], needsYou: 0, truncated: false, ...over,
});

describe("plain-language bullets", () => {
  it("names the largest groups and folds the rest into one item (en)", () => {
    const b = bullets(fixtureDigest("r1"));
    expect(b[0]).toBe("Changed 4 screen files, 2 settings files, 1 style file, and 2 more files.");
    expect(b).toContain("3 new files, none deleted.");
    expect(b).toContain("Added 1 new package: react-native-maps.");
    expect(b).toContain("Ran 3 commands, 1 of them failed.");
    expect(b).toContain("The agent's last word: “The store page now opens a map with the store's pin.”");
    expect(b.length).toBeGreaterThanOrEqual(3);
    expect(b.length).toBeLessThanOrEqual(MAX_BULLETS);
  });

  it("uses singular forms for one", () => {
    const d = empty({ fileCount: 1, created: 1, groups: [{ purpose: "ui", created: 1, modified: 0, deleted: 0, examples: [] }], commandCount: 1, commands: [{ text: "npm test", failed: false }], additions: 1, deletions: 1 });
    expect(bullets(d)).toEqual(["Changed 1 screen file.", "1 new file, none deleted.", "1 line added, 1 line removed.", "Ran 1 command."]);
  });

  it("speaks Hungarian with Hungarian number agreement", async () => {
    await setLocale("hu");
    const b = bullets(fixtureDigest("r1"));
    expect(b[0]).toBe("4 képernyőfájl, 2 beállításfájl, 1 stílusfájl és 2 további fájl változott.");
    expect(b).toContain("1 új csomagot adott hozzá: react-native-maps.");
    expect(b).toContain("3 parancsot futtatott, ebből 1 nem sikerült.");
    expect(b).toContain("3 új fájl, törölt nincs.");
    expect(bullets(empty())).toEqual(["Egyetlen fájl sem változott."]);
  });

  it("keeps at most six, the most useful ones, in reading order", () => {
    const d = empty({
      fileCount: 3, created: 1, deleted: 1, additions: 5, deletions: 2,
      groups: [{ purpose: "code", created: 1, modified: 1, deleted: 1, examples: [] }],
      commandCount: 2, commands: [{ text: "a", failed: false }, { text: "b", failed: false }],
      risks: [{ code: "newDependencies", count: 1, evidence: ["axios"] }],
      failureCount: 1, needsYou: 2, decisions: [{ kind: "final", text: "Done.", done: false }],
    });
    const b = bullets(d);
    expect(b).toHaveLength(MAX_BULLETS);
    expect(b[0]).toBe("Changed 3 code files.");
    expect(b.at(-1)).toBe("The agent's last word: “Done.”");
    expect(b.join(" ")).not.toContain("line added"); // the least useful one goes first
    expect(b).toContain("2 requests are still waiting for you.");
  });

  it("falls back to the plan when there is no final message, and says when nothing changed", () => {
    expect(bullets(empty({ decisions: [{ kind: "plan", text: "Add a theme", done: false }] }))).toEqual(["No files were changed.", "The plan: “Add a theme”"]);
  });
});

describe("what to check", () => {
  it("names the dev and test scripts of the run's repository", () => {
    const lines = checkLines(fixtureDigest("r1"), { storefront: [{ group: "start", runner: "npm start" }, { group: "dev", runner: "npm run dev" }, { group: "test", runner: "npm test" }] });
    expect(lines).toEqual([
      "Install the packages again before you start the app (the package list changed).",
      "Start the app with npm run dev and look at the changed screens.",
      "Rebuild the iOS app: native files changed, a reload is not enough.",
      "Rebuild the Android app: native files changed, a reload is not enough.",
      "Run the tests with npm test.",
    ]);
  });

  it("uses a generic line without scripts and names the repository when there are several", () => {
    const d = empty({ repos: [{ repoId: "web", source: "git", fileCount: 1, created: 0, modified: 1, deleted: 0, additions: 0, deletions: 0, purposes: ["ui"], ios: false, android: false }, { repoId: "api", source: "git", fileCount: 0, created: 0, modified: 0, deleted: 0, additions: 0, deletions: 0, purposes: [], ios: false, android: false }], checks: [{ code: "devServer", repoIds: ["web"] }, { code: "answerNeeds", repoIds: [] }] });
    expect(checkLines(d, {}, (id) => id.toUpperCase())).toEqual(["WEB: Open the app and look at the changed screens.", "Answer the questions the run is still waiting on."]);
    expect(scriptRepos(d)).toEqual(["web"]);
  });

  it("speaks Hungarian", async () => {
    await setLocale("hu");
    expect(checkLines(fixtureDigest("r1"), { storefront: [{ group: "dev", runner: "npm run dev" }] })[1]).toBe("Indítsd el az alkalmazást ezzel: npm run dev, és nézd meg a módosított képernyőket.");
  });
});

describe("risks and the chip", () => {
  it("lists evidence, capped at three names and N more", () => {
    const d = empty({ risks: [{ code: "filesDeleted", count: 5, evidence: ["a.js", "b.js", "c.js", "d.js", "e.js"] }, { code: "networkCalls", count: 2, evidence: [] }, { code: "envFileTouched", count: 1, evidence: [".env"] }] });
    expect(riskLines(d).map((r) => r.text)).toEqual(["Deleted 5 files: a.js, b.js, c.js, and 2 more.", "Reached the internet 2 times.", "Touched an environment file that may hold secrets: .env."]);
  });

  it("explains every risk code in en and hu without a raw key", async () => {
    const codes = ["configTouched", "lockfileChanged", "envFileTouched", "permissionsTouched", "filesDeleted", "newDependencies", "networkCalls", "gitHistory", "failures", "needsYou"] as const;
    const d = empty({ risks: codes.map((code) => ({ code, count: 1, evidence: ["x"] })) });
    for (const lang of ["en", "hu"]) {
      await setLocale(lang);
      for (const r of riskLines(d)) expect(r.text, `${lang} ${r.code}`).not.toMatch(/runsummary\.|\{/);
    }
    expect(riskLines(d)[6].text).toBe("Egyszer kapcsolódott az internethez (x).");
  });

  it("counts files and risks on the chip", async () => {
    expect(chipText(fixtureDigest("r1"))).toBe("9 files · 3 risks");
    expect(chipText(empty({ fileCount: 1 }))).toBe("1 file");
    await setLocale("hu");
    expect(chipText(fixtureDigest("r1"))).toBe("9 fájl · 3 kockázat");
  });

  it("treats done and error as finished", () => {
    expect([isFinished("done"), isFinished("error"), isFinished("running"), isFinished("needsYou")]).toEqual([true, true, false, false]);
  });
});

describe("the explanation prompt", () => {
  it("holds the digest facts only and asks for the UI language", () => {
    const p = explainPrompt(fixtureDigest("r1"), "Hungarian");
    expect(p).toContain("Answer in Hungarian.");
    expect(p).toContain("Do not run tools");
    expect(p).toContain("- screens and components: 4 (src/screens/MapScreen.tsx, src/components/StorePin.tsx, src/navigation.tsx)");
    expect(p).toContain("- curl -s https://maps.example.com/v1/geocode?key=***");
    expect(p).toContain("- npm test -- MapScreen [failed, exit 1]");
    expect(p).toContain("- permissionsTouched (2): ios/Storefront/Info.plist, android/app/src/main/AndroidManifest.xml");
  });
});
