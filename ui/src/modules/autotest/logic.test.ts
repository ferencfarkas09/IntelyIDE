import { describe, expect, it } from "vitest";
import { blockedBy, cleanLine, finishedBetween, linesOfLastStart, maskSecrets, MAX_FAILURES, MAX_TEXT, outcomeOf, parseDuration, parseTestOutput } from "./logic";

const E = "\x1b";
const red = (s: string) => `${E}[31m${s}${E}[39m`;
const bold = (s: string) => `${E}[1m${s}${E}[22m`;

const VITEST_FAIL = [
  "",
  ` ${bold("RUN")}  v2.1.8 /Users/me/shop`,
  "",
  ` ${E}[32m✓${E}[39m src/cart.test.ts (6 tests) 12ms`,
  ` ${red("❯")} src/price.test.ts (4 tests | 2 failed) 9ms`,
  `   ${red("×")} price > adds VAT 4ms`,
  `     → expected 127 to be 127.5 // Object.is equality`,
  `   ${red("×")} price > rounds down 1ms`,
  `     → expected 3 to be 2`,
  "",
  `${red("⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯")}`,
  "",
  ` ${red(bold(" FAIL "))} src/price.test.ts > price > adds VAT`,
  `${red("AssertionError")}: expected 127 to be 127.5 // Object.is equality`,
  "",
  "- Expected",
  "+ Received",
  "",
  ` ${red(bold(" FAIL "))} src/price.test.ts > price > rounds down`,
  `${red("AssertionError")}: expected 3 to be 2 // Object.is equality`,
  "",
  `${E}[2m Test Files ${E}[22m ${red(bold("1 failed"))}${E}[2m | ${E}[22m${E}[32m1 passed${E}[39m${E}[90m (2)${E}[39m`,
  `${E}[2m      Tests ${E}[22m ${red(bold("2 failed"))}${E}[2m | ${E}[22m${E}[32m7 passed${E}[39m${E}[2m | ${E}[22m1 skipped${E}[90m (10)${E}[39m`,
  `${E}[2m   Start at ${E}[22m 10:02:11`,
  `${E}[2m   Duration ${E}[22m 1.31s${E}[2m (transform 90ms, setup 0ms, collect 120ms, tests 16ms)${E}[22m`,
];

const VITEST_PASS = [" RUN  v1.6.0 /repo", "", " ✓ src/a.test.ts  (3 tests) 3ms", "", " Test Files  1 passed (1)", "      Tests  3 passed (3)", "   Start at  09:00:00", "   Duration  412ms"];

const JEST_FAIL = [
  "> shop@1.0.0 test",
  "> jest",
  "",
  `${E}[0m${E}[7m${E}[1m${E}[31m FAIL ${E}[39m${E}[22m${E}[27m${E}[0m src/cart.test.js`,
  "  cart",
  `    ${red("✕")} totals the items (5 ms)`,
  `    ${E}[32m✓${E}[39m starts empty (1 ms)`,
  "",
  `${bold(red("  ● cart › totals the items"))}`,
  "",
  `    ${E}[2mexpect(${E}[22m${red("received")}${E}[2m).${E}[22mtoBe${E}[2m(${E}[22m${E}[32mexpected${E}[39m${E}[2m) // Object.is equality${E}[22m`,
  "",
  "    Expected: 30",
  "    Received: 25",
  "",
  `${bold("Test Suites: ")}${bold(red("1 failed"))}, ${E}[1m${E}[32m2 passed${E}[39m${E}[22m, 3 total`,
  `${bold("Tests:       ")}${bold(red("1 failed"))}, ${E}[33m1 skipped${E}[39m, ${E}[1m${E}[32m11 passed${E}[39m${E}[22m, 13 total`,
  `${bold("Snapshots:   ")}0 total`,
  `${bold("Time:        ")}2.468 s`,
  `${E}[2mRan all test suites${E}[22m${E}[2m.${E}[22m`,
];

const JEST_RN_PASS = ["> MyApp@0.0.1 test", "> jest", "", "PASS __tests__/App.test.tsx (8.123 s)", "  ✓ renders correctly (1234 ms)", "", "Test Suites: 1 passed, 1 total", "Tests:       1 passed, 1 total", "Snapshots:   0 total", "Time:        9.01 s, estimated 10 s", "Ran all test suites."];

const CARGO_FAIL = [
  "   Compiling shop v0.1.0 (/Users/me/shop)",
  "    Finished `test` profile [unoptimized + debuginfo] target(s) in 3.21s",
  "     Running unittests src/lib.rs (target/debug/deps/shop-1a2b3c)",
  "",
  "running 3 tests",
  "test price::tests::adds_vat ... ok",
  "test price::tests::rounds ... FAILED",
  "test cart::tests::slow ... ignored",
  "",
  "failures:",
  "",
  "---- price::tests::rounds stdout ----",
  "",
  "thread 'price::tests::rounds' panicked at src/price.rs:42:9:",
  "assertion `left == right` failed",
  "  left: 3",
  " right: 2",
  "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace",
  "",
  "",
  "failures:",
  "    price::tests::rounds",
  "",
  "test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.02s",
  "",
  "error: test failed, to rerun pass `--lib`",
];

const CARGO_PASS_TWO_BINARIES = [
  "running 2 tests",
  "test a ... ok",
  "test b ... ok",
  "",
  "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.50s",
  "",
  "   Doc-tests shop",
  "running 1 test",
  "test src/lib.rs - add (line 3) ... ok",
  "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.25s",
];

const CARGO_OLD_PANIC = ["---- t::x stdout ----", "thread 't::x' panicked at 'boom happened', src/lib.rs:3:5", "", "test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out"];

const CARGO_BUILD_ERROR = ["   Compiling shop v0.1.0", "error[E0425]: cannot find value `x` in this scope", " --> src/lib.rs:2:5", "error: could not compile `shop` (lib test) due to 1 previous error"];

const PYTEST_FAIL = [
  "..F.s                                                                    [100%]",
  "=================================== FAILURES ===================================",
  "___________________________________ test_add ___________________________________",
  "",
  "    def test_add():",
  ">       assert add(1, 2) == 4",
  "E       assert 3 == 4",
  "E        +  where 3 = add(1, 2)",
  "",
  "tests/test_math.py:5: AssertionError",
  "=========================== short test summary info ============================",
  "FAILED tests/test_math.py::test_add - assert 3 == 4",
  "1 failed, 3 passed, 1 skipped in 0.12s",
];

const PYTEST_LONG_SUMMARY = ["============================= test session starts ==============================", "collected 7 items", "", "tests/test_a.py .......                                                  [100%]", "", "============================== 7 passed, 2 warnings in 1.50s ==============================="];

describe("cleanLine", () => {
  it("drops colour codes and what a carriage return overwrote", () => {
    expect(cleanLine(`${E}[31mred${E}[39m plain`)).toBe("red plain");
    expect(cleanLine("10%\r50%\r100% done")).toBe("100% done");
    expect(cleanLine("line\r")).toBe("line");
    expect(cleanLine(`${E}]8;;https://x${E}\\link${E}]8;;${E}\\`)).toBe("link");
  });
});

describe("parseDuration", () => {
  it("reads the units the runners print", () => {
    expect(parseDuration("1.31s (transform 90ms)")).toBe(1310);
    expect(parseDuration("412ms")).toBe(412);
    expect(parseDuration("2.468 s")).toBe(2468);
    expect(parseDuration("1m 3s")).toBe(63000);
    expect(parseDuration("soon")).toBeUndefined();
  });
});

describe("parseTestOutput", () => {
  it("reads a failing Vitest run with colours", () => {
    const r = parseTestOutput(VITEST_FAIL, "vitest");
    expect(r).toMatchObject({ runner: "vitest", matched: true, passed: 7, failed: 2, skipped: 1, durationMs: 1310 });
    expect(r.failures).toEqual([
      { name: "src/price.test.ts > price > adds VAT", message: "AssertionError: expected 127 to be 127.5 // Object.is equality" },
      { name: "src/price.test.ts > price > rounds down", message: "AssertionError: expected 3 to be 2 // Object.is equality" },
    ]);
  });

  it("reads a passing Vitest run, also without a hint", () => {
    expect(parseTestOutput(VITEST_PASS)).toMatchObject({ runner: "vitest", matched: true, passed: 3, failed: 0, skipped: 0, durationMs: 412, failures: [] });
  });

  it("names the failures of a Vitest log cut before its summary", () => {
    const r = parseTestOutput(VITEST_FAIL.slice(0, 9), "vitest");
    expect(r.matched).toBe(false);
    expect(r.failures.map((f) => f.name)).toEqual(["price > adds VAT", "price > rounds down"]);
    expect(r.failures[0].message).toBe("expected 127 to be 127.5 // Object.is equality");
  });

  it("reads a failing Jest run", () => {
    const r = parseTestOutput(JEST_FAIL, "jest");
    expect(r).toMatchObject({ runner: "jest", matched: true, passed: 11, failed: 1, skipped: 1, durationMs: 2468 });
    expect(r.failures).toEqual([{ name: "cart › totals the items", message: "expect(received).toBe(expected) // Object.is equality" }]);
  });

  it("reads a React Native Jest run with an estimate", () => {
    expect(parseTestOutput(JEST_RN_PASS, "jest")).toMatchObject({ runner: "jest", matched: true, passed: 1, failed: 0, durationMs: 9010 });
  });

  it("reads cargo test, sums the test binaries and finds the panic message", () => {
    const r = parseTestOutput(CARGO_FAIL, "cargo");
    expect(r).toMatchObject({ runner: "cargo", matched: true, passed: 1, failed: 1, skipped: 1, durationMs: 20 });
    expect(r.failures).toEqual([{ name: "price::tests::rounds", message: "assertion `left == right` failed" }]);
    expect(parseTestOutput(CARGO_PASS_TWO_BINARIES, "cargo")).toMatchObject({ matched: true, passed: 3, failed: 0, durationMs: 750 });
    expect(parseTestOutput(CARGO_OLD_PANIC, "cargo").failures).toEqual([{ name: "t::x", message: "boom happened" }]);
  });

  it("reports a cargo build error as the failure", () => {
    const r = parseTestOutput(CARGO_BUILD_ERROR, "cargo");
    expect(r.matched).toBe(false);
    expect(r.failures).toEqual([{ name: "cargo build", message: "error[E0425]: cannot find value `x` in this scope" }]);
  });

  it("reads pytest -q and the long summary line", () => {
    const r = parseTestOutput(PYTEST_FAIL, "pytest");
    expect(r).toMatchObject({ runner: "pytest", matched: true, passed: 3, failed: 1, skipped: 1, durationMs: 120 });
    expect(r.failures).toEqual([{ name: "tests/test_math.py::test_add", message: "assert 3 == 4" }]);
    expect(parseTestOutput(PYTEST_LONG_SUMMARY)).toMatchObject({ runner: "pytest", matched: true, passed: 7, failed: 0, durationMs: 1500 });
    // cut before the short summary: the section header and its first E line
    const cut = parseTestOutput(PYTEST_FAIL.slice(0, 9), "pytest");
    expect(cut.matched).toBe(false);
    expect(cut.failures).toEqual([{ name: "test_add", message: "assert 3 == 4" }]);
  });

  it("is unknown when nothing matches, and a wrong hint still finds the right runner", () => {
    expect(parseTestOutput(["hello", "world"], "jest")).toEqual({ runner: "unknown", matched: false, passed: 0, failed: 0, skipped: 0, failures: [] });
    expect(parseTestOutput([])).toMatchObject({ runner: "unknown", matched: false });
    expect(parseTestOutput(JEST_FAIL, "vitest")).toMatchObject({ runner: "jest", failed: 1 });
  });

  it("caps the number and the length of the failures", () => {
    const lines: string[] = [];
    for (let i = 0; i < 12; i++) lines.push(`  ● suite › case ${i}`, "", `    ${"x".repeat(1000)}`);
    lines.push("Tests:       12 failed, 12 total");
    const r = parseTestOutput(lines, "jest");
    expect(r.failures).toHaveLength(MAX_FAILURES);
    expect(r.failures[0].message.length).toBe(MAX_TEXT);
    expect(r.failures[0].message.endsWith("…")).toBe(true);
  });
});

describe("linesOfLastStart and outcomeOf", () => {
  it("keeps only the lines of the latest start", () => {
    expect(linesOfLastStart(["─── npm run test ───", "old", "─── exited ───", "─── npm run test ───", "new"], "npm run test")).toEqual(["new"]);
    expect(linesOfLastStart(["cut", "lines"], "npm run test")).toEqual(["cut", "lines"]);
  });

  it("passes only on exit code 0 with no failure", () => {
    const ok = parseTestOutput(VITEST_PASS);
    expect(outcomeOf(ok, 0)).toBe("passed");
    expect(outcomeOf(ok, 1)).toBe("failed");
    expect(outcomeOf(parseTestOutput(VITEST_FAIL), 0)).toBe("failed");
    expect(outcomeOf(parseTestOutput([]), null)).toBe("failed");
  });
});

describe("maskSecrets", () => {
  it("masks secret shapes and keeps the rest readable", () => {
    const gh = `ghp_${"a1B2".repeat(9)}`;
    const text = [
      `token ${gh} leaked`,
      "fetch https://admin:hunter2@db.example.test/x",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
      'API_KEY=sk-live-1234567890abcdef1234 and "password": "pa55word!"',
      "key AKIAABCDEFGHIJKLMNOP",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "expected 3 to be 4",
    ].join("\n");
    const out = maskSecrets(text);
    for (const leak of [gh, "hunter2", "abcdefghijklmnopqrstuvwxyz123456", "sk-live-1234567890abcdef1234", "pa55word", "AKIAABCDEFGHIJKLMNOP", "dozjgNryP4J3jVmNHl0w5N"]) expect(out).not.toContain(leak);
    expect(out).toContain("https://***@db.example.test/x");
    expect(out).toContain("Bearer ***");
    expect(out).toContain("expected 3 to be 4");
  });
});

describe("blockedBy and finishedBetween", () => {
  const runs = [
    { agentId: "a", status: "done", repoIds: ["r1", "r2"] },
    { agentId: "b", status: "running", repoIds: ["r2"] },
    { agentId: "c", status: "needsYou", repoIds: ["r3"] },
  ];

  it("blocks while the run itself or another run on the repo is live", () => {
    expect(blockedBy(runs, "a", "r1")).toBeUndefined();
    expect(blockedBy(runs, "a", "r2")).toBe("other");
    expect(blockedBy(runs, "c", "r3")).toBe("self");
    expect(blockedBy(runs, "gone", "r1")).toBeUndefined();
  });

  it("sees only live-to-finished transitions", () => {
    const before = new Map([["a", "running"], ["b", "needsYou"], ["c", "done"]]);
    const now = [
      { agentId: "a", status: "done", repoIds: [] },
      { agentId: "b", status: "error", repoIds: [] },
      { agentId: "c", status: "done", repoIds: [] },
      { agentId: "d", status: "done", repoIds: [] },
    ];
    expect(finishedBetween(before, now)).toEqual(["a", "b"]);
  });
});
