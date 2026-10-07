import { describe, expect, it } from "vitest";
import { argsFromLines, commandLine, launchLine, launchProblem, shellWord } from "./launch";

describe("the command line shown for confirmation", () => {
  it("is exact: plain words as they are, anything else single-quoted so it can be copied back", () => {
    expect(commandLine("/usr/local/bin/codex", ["app-server"])).toBe("/usr/local/bin/codex app-server");
    expect(commandLine("/opt/my agent/run", ["--name", "it's", "a b"])).toBe(`'/opt/my agent/run' --name 'it'\\''s' 'a b'`);
    expect(shellWord("--acp")).toBe("--acp");
    expect(shellWord("")).toBe("''");
    expect(launchLine({ command: "/x/y", args: ["--stdio", "--acp"] })).toBe("/x/y --stdio --acp");
  });

  it("shows nothing for a program that is not known yet instead of a half line", () => {
    expect(commandLine("", ["--acp"])).toBe("--acp");
    expect(launchProblem("")).toBe("empty");
  });

  it("takes arguments one per line and drops blank lines only", () => {
    expect(argsFromLines("--stdio\n\n  \r\n--mode=acp\r\n")).toEqual(["--stdio", "--mode=acp"]);
    expect(argsFromLines("")).toEqual([]);
    expect(argsFromLines(" --a b ")).toEqual([" --a b "]);
  });

  it("wants an absolute program path; the backend checks again", () => {
    expect(launchProblem("my-agent")).toBe("relative");
    expect(launchProblem("./agent")).toBe("relative");
    expect(launchProblem("/opt/agents/my-agent")).toBeNull();
    expect(launchProblem("  /opt/a ")).toBeNull();
  });
});
