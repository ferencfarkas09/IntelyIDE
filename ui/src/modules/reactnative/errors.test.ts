import { describe, expect, it } from "vitest";
import { classifyError, collectErrors, MAX_CARDS, plain } from "./errors";
import type { ErrorKind } from "./types";

const SAMPLES: [ErrorKind, string][] = [
  ["unresolvedModule", 'error: Unable to resolve module ./Missing from /Users/me/app/App.js: ./Missing could not be found'],
  ["unresolvedModule", 'Unable to resolve "react-native-reanimated" from "src/Screen.tsx"'],
  ["redbox", " ERROR  Invariant Violation: \"main\" has not been registered."],
  ["undefinedFunction", "TypeError: undefined is not a function"],
  ["undefinedFunction", "TypeError: Cannot read properties of undefined (reading 'map')"],
  ["undefinedFunction", "TypeError: Cannot read property 'map' of undefined"],
  ["nativeCrash", "05-01 10:00:03.400  1234  1234 E AndroidRuntime: FATAL EXCEPTION: mqt_native_modules"],
  ["nativeCrash", "05-01 10:00:04.500  1234  1234 F libc    : Fatal signal 11 (SIGSEGV), code 1"],
  ["nativeCrash", "2024-05-01 10:00:03.400 Fa  MyApp[1234:5678] *** Terminating app due to uncaught exception 'NSInvalidArgumentException'"],
  ["gradleFailed", "FAILURE: Build failed with an exception."],
  ["gradleFailed", "* What went wrong:"],
  ["gradleFailed", "Execution failed for task ':app:compileDebugJavaWithJavac'."],
  ["gradleFailed", "SDK location not found. Define a valid SDK location with an ANDROID_HOME environment variable"],
  ["xcodeFailed", "** BUILD FAILED **"],
  ["xcodeFailed", "error: /Users/me/app/ios/AppDelegate.mm:12:9: 'Foo.h' file not found"],
  ["xcodeFailed", "error: Signing for \"App\" requires a development team. Code signing is required for product type 'Application'"],
  ["noBundleUrl", "No bundle URL present. Make sure you're running a packager server or have included a .jsbundle file in your application bundle."],
  ["portInUse", "error listen EADDRINUSE: address already in use :::8081"],
  ["portInUse", "Port 8081 is being used by another process"],
  ["portInUse", "Port 8081 is already in use"],
  ["podsOutOfDate", "The sandbox is not in sync with the Podfile.lock. Run 'pod install' or update your CocoaPods installation."],
  ["jsException", "ReferenceError: Property 'foo' doesn't exist"],
];

describe("classifyError", () => {
  it.each(SAMPLES)("%s: %s", (kind, line) => {
    expect(classifyError(line)).toBe(kind);
  });

  it("sees through colour codes", () => {
    expect(classifyError("\u001b[31merror\u001b[39m: Unable to resolve module ./x from /a/b.js")).toBe("unresolvedModule");
  });

  it("leaves ordinary output alone", () => {
    for (const line of ["", "   ", "Metro waiting on exp://192.168.1.20:8081", "iOS Bundled 812ms index.js (1 module)", "LOG  Hello", "WARN  Require cycle: a.js -> b.js", "Running \"main\" with {\"rootTag\":1}", "05-01 10:00:00.100  1234  5678 I ReactNativeJS: Running"]) {
      expect(classifyError(line), line).toBeUndefined();
    }
  });

  it("survives hostile input", () => {
    const evil = ["\u0000".repeat(5000), "a".repeat(200_000), "\u001b[".repeat(5000), "(".repeat(10_000), "𐀀 ‮", `Invariant Violation${" ".repeat(100_000)}`, "Port ".repeat(50_000)];
    for (const line of evil) expect(() => classifyError(line)).not.toThrow();
  });
});

describe("plain", () => {
  it("strips colour codes and control characters and caps the length", () => {
    expect(plain("\u001b[31mred\u001b[0m\u0007 text\u0000")).toBe("red text");
    expect(plain("x".repeat(1000)).length).toBe(300);
    expect(plain("  padded  ")).toBe("padded");
  });
});

describe("collectErrors", () => {
  it("makes one card per error, with the lines after it as context", () => {
    const cards = collectErrors(["Starting Metro", "error: Unable to resolve module ./Missing from /a/App.js", "  at foo (App.js:1)", "  at bar (App.js:2)", "iOS Bundled"], "metro");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "unresolvedModule", source: "metro", count: 1 });
    expect(cards[0].context).toEqual(["at foo (App.js:1)", "at bar (App.js:2)", "iOS Bundled"]);
  });

  it("counts a repeated error instead of adding cards, also across calls, and ignores numbers like pids", () => {
    let cards = collectErrors(["05-01 10:00:03.400  1234  1234 E AndroidRuntime: FATAL EXCEPTION: main"], "android");
    cards = collectErrors(["05-01 10:05:09.100  9876  9876 E AndroidRuntime: FATAL EXCEPTION: main"], "android", cards);
    expect(cards).toHaveLength(1);
    expect(cards[0].count).toBe(2);
  });

  it("keeps different errors apart and at most MAX_CARDS of them", () => {
    const lines = Array.from({ length: MAX_CARDS + 5 }, (_, i) => `TypeError: thing${"x".repeat(i)}Name is not a function`);
    const cards = collectErrors(lines, "ios");
    expect(cards).toHaveLength(MAX_CARDS);
    expect(cards[cards.length - 1].snippet).toContain("x".repeat(MAX_CARDS + 4));
  });

  it("does not change the cards it was given", () => {
    const first = collectErrors(["No bundle URL present."], "ios");
    const snapshot = JSON.stringify(first);
    collectErrors(["No bundle URL present."], "ios", first);
    expect(JSON.stringify(first)).toBe(snapshot);
  });

  it("copes with a flood of lines", () => {
    const lines = Array.from({ length: 50_000 }, (_, i) => (i % 1000 === 0 ? "Invariant Violation: x" : `line ${i}`));
    expect(collectErrors(lines, "metro").length).toBeGreaterThan(0);
  });
});
