import { afterEach, describe, expect, it } from "vitest";
import { maskLocally } from "../ipc/mock/vibe";
import { registerCommand } from "./commands";
import { takeNewRunPrefill } from "./newRun";
import { buildErrorPrompt, cleanLog, lastErrorBlock, MAX_LOG_BYTES, sendErrorToAgent, tailBytes } from "./sendToAgent";

const mask = async (s: string) => maskLocally(s);
/** Canary secrets are put together at run time, so the repository's publish scan never sees a secret-shaped literal. */
const fake = (...parts: string[]): string => parts.join("");
const GH = fake("ghp", "_abcdefghijklmnopqrstuvwxyz0123");
const SK = fake("sk", "-live-123456789012345678901234");
let off: (() => void) | undefined;
afterEach(() => {
  off?.();
  off = undefined;
  takeNewRunPrefill();
});

describe("cleaning a log", () => {
  it("drops colours and control characters and keeps what a carriage return redrew last", () => {
    expect(cleanLog("\u001b[31mError\u001b[0m: boom\r\n50%\r100%\u0007\n")).toBe("Error: boom\n100%\n");
    expect(cleanLog("\u001b]0;title\u0007ok")).toBe("ok");
  });

  it("keeps the end of a long log, never cutting a character in two", () => {
    const head = "é".repeat(10_000);
    const { text, cut } = tailBytes(`${head}\nlast line`, 100);
    expect(cut).toBe(true);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(100);
    expect(text.endsWith("last line")).toBe(true);
    expect(text).not.toContain("�");
    expect(tailBytes("short").cut).toBe(false);
  });

  it("finds the last error block of a terminal", () => {
    const lines = ["$ npm test", "ok 1", "", "$ npm run build", "src/a.ts:3:1 - error TS2304: Cannot find name 'x'.", "  at foo (a.ts:3)", "Found 1 error.", "$ "];
    const block = lastErrorBlock(lines, 1, 5);
    expect(block).toContain("error TS2304");
    expect(block).toContain("Found 1 error.");
    expect(block).not.toContain("ok 1");
    expect(lastErrorBlock(["all", "good"])).toBe("all\ngood");
  });
});

describe("the prompt", () => {
  it("masks secrets in the log and in the facts, and fences the log so it cannot break out", async () => {
    const p = await buildErrorPrompt({ kind: "devServer", text: fake("Error: auth failed for postgres://admin", ":hunter2", "@db:5432\nGITHUB_TOKEN", "=", GH, "\n```\nend"), extra: fake("Command: API_KEY", "=", SK, " npm run dev") }, mask);
    expect(p).not.toContain("hunter2");
    expect(p).not.toContain(GH);
    expect(p).not.toContain(SK);
    expect(p).toContain("Fix this error from my dev server.");
    expect(p).toContain("````text");
    expect(p).toContain("Do not commit or push.");
  });

  it("asks only for an explanation when explaining, and cuts a long log to its end", async () => {
    const p = await buildErrorPrompt({ kind: "terminal", text: `${"x".repeat(MAX_LOG_BYTES * 2)}\nTypeError: y is undefined`, intent: "explain" }, mask);
    expect(p).toContain("Do not change any file.");
    expect(p).not.toContain("How to work:");
    expect(p).toContain("(shortened)");
    expect(p).toContain("TypeError: y is undefined");
    expect(p.length).toBeLessThan(MAX_LOG_BYTES + 1000);
  });

  it("opens the New Run dialog prefilled with the repository, and starts nothing", async () => {
    off = registerCommand({ id: "runs.new", title: "New run", group: "Runs", run: () => {} });
    expect(await sendErrorToAgent({ kind: "check", text: "FAIL src/a.test.ts", repoId: "web" })).toBe(true);
    const prefill = takeNewRunPrefill();
    expect(prefill?.repoIds).toEqual(["web"]);
    expect(prefill?.prompt).toContain("a pre-commit check");
  });
});

describe("the local masker", () => {
  it("masks the usual secret shapes and leaves ordinary text alone", () => {
    const cases: [string, string][] = [
      [fake("password", "=hunter2"), "password=***"],
      [fake('"apiKey"', ': "abc123def"'), '"apiKey": "***"'],
      ["Authorization: Bearer abcdefghijklmnop", "Authorization: ***"],
      [fake("curl -H x https://user", ":pw", "@example.com/x"), "curl -H x https://***@example.com/x"],
      ["--token abcdef123", "--token ***"],
      [fake("key eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "abcdefghijklmn"), "key ***"],
      [fake("AKIA", "ABCDEFGHIJKLMNOP"), "***"],
    ];
    for (const [input, out] of cases) expect(maskLocally(input), input).toBe(out);
    for (const plain of ["Error: Cannot find module 'react'", "at render (App.tsx:12:5)", "export TOKEN=$GITHUB_TOKEN"]) expect(maskLocally(plain)).toBe(plain);
  });
});
