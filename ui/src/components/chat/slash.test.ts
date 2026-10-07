import { describe, expect, it } from "vitest";
import { ideCommandOf, slashEntries, slashQuery } from "./slash";

describe("slashQuery", () => {
  it("is the command word while the text is only that", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/mc")).toBe("mc");
  });
  it("is null with a space, a newline, other text or no slash", () => {
    expect(slashQuery("/compact now")).toBeNull();
    expect(slashQuery("/mcp\n")).toBeNull();
    expect(slashQuery("hello /mcp")).toBeNull();
    expect(slashQuery("")).toBeNull();
  });
});

describe("ideCommandOf", () => {
  it("recognizes a typed-out IDE command, with trailing blanks and any case", () => {
    expect(ideCommandOf("/mcp")).toBe("mcp");
    expect(ideCommandOf("/MCP  ")).toBe("mcp");
    expect(ideCommandOf("/agents")).toBe("agents");
    expect(ideCommandOf("/mode")).toBe("mode");
  });
  it("leaves CLI commands, arguments and prose alone", () => {
    expect(ideCommandOf("/compact")).toBeNull();
    expect(ideCommandOf("/mcp list")).toBeNull();
    expect(ideCommandOf("mcp")).toBeNull();
  });
});

describe("slashEntries", () => {
  const cli = ["compact", "context", "cost", "review", "init", "mcp", "agents"];
  it("lists the IDE commands first, then the CLI's own, without duplicating the IDE names", () => {
    const all = slashEntries("", cli);
    expect(all.map((e) => `${e.kind}:${e.name}`)).toEqual(["ide:mcp", "ide:agents", "ide:mode", "cli:compact", "cli:context", "cli:cost", "cli:review", "cli:init"]);
  });
  it("filters by prefix, then by substring, case-insensitively", () => {
    expect(slashEntries("CO", cli).map((e) => e.name)).toEqual(["compact", "context", "cost"]);
    expect(slashEntries("view", cli).map((e) => e.name)).toEqual(["review"]);
    expect(slashEntries("m", cli).map((e) => e.name)).toEqual(["mcp", "mode", "compact"]);
  });
  it("is empty when nothing matches and works without CLI commands", () => {
    expect(slashEntries("zzz", cli)).toEqual([]);
    expect(slashEntries("", undefined).map((e) => e.name)).toEqual(["mcp", "agents", "mode"]);
  });
  it("accepts names that already carry a slash", () => {
    expect(slashEntries("rev", ["/review"]).map((e) => e.name)).toEqual(["review"]);
  });
});
