import { describe, expect, it } from "vitest";
import en from "../../i18n/locales/en/mcp.json";
import hu from "../../i18n/locales/hu/mcp.json";
import { CATALOG, CATEGORIES, entryLine, entryVars, freeName, matchesCatalog, needsNode, needsSecret, templateOf } from "./catalog";
import { argsProblem, commandProblem, isSecretName, nameProblem, urlProblem, varNameProblem } from "./logic";

const enAll = en as Record<string, string>;
const huAll = hu as Record<string, string>;
/** `pkg@1.2.3` / `@scope/pkg@1.2.3`: what the confirm dialog treats as a fixed program (`pinned` in crates/mcp/src/model.rs). */
const PINNED = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*@\d+\.\d+\.\d+$/i;

describe("the MCP catalog", () => {
  it("has unique entries whose id is a valid server name", () => {
    expect(new Set(CATALOG.map((e) => e.id)).size).toBe(CATALOG.length);
    for (const e of CATALOG) expect(nameProblem(e.id), e.id).toBeNull();
    expect(CATALOG.map((e) => e.category).every((c) => CATEGORIES.includes(c))).toBe(true);
  });

  it("passes every check the editor and Rust make before a save", () => {
    for (const e of CATALOG) {
      if (e.transport === "stdio") {
        expect(commandProblem(e.command ?? ""), e.id).toBeNull();
        expect(argsProblem([...(e.args ?? [])]), e.id).toBeNull();
        expect(e.url, e.id).toBeUndefined();
        expect(e.headers ?? [], e.id).toEqual([]);
      } else {
        expect(urlProblem(e.url ?? ""), e.id).toBeNull();
        expect(e.command, e.id).toBeUndefined();
        expect(e.env ?? [], e.id).toEqual([]);
      }
      for (const v of e.env ?? []) expect(varNameProblem("env", v.name), `${e.id} ${v.name}`).toBeNull();
      for (const v of e.headers ?? []) expect(varNameProblem("header", v.name), `${e.id} ${v.name}`).toBeNull();
    }
  });

  it("pins every package it fetches, so the code is the one that was checked", () => {
    for (const e of CATALOG.filter(needsNode)) {
      const pkg = (e.args ?? []).find((a) => !a.startsWith("-"));
      expect(pkg, e.id).toMatch(PINNED);
    }
  });

  it("never carries a value for a secret: secret variables are names only, plain ones may carry the value that is set for the person", () => {
    for (const e of CATALOG) {
      for (const v of [...(e.env ?? []), ...(e.headers ?? [])]) {
        const keys = Object.keys(v).filter((k) => k !== "smoke").sort();
        if (v.secret) expect(keys, `${e.id} ${v.name}`).toEqual(["name", "secret"]);
        else expect(keys, `${e.id} ${v.name}`).toEqual(["name", "secret", "value"]);
        if (isSecretName(v.name)) expect(v.secret, `${e.id} ${v.name}`).toBe(true);
      }
      expect((e.args ?? []).filter((a) => a.includes("=")), `${e.id} has a value in its arguments`).toEqual([]);
      expect(e.url ?? "", e.id).not.toMatch(/@|\?/);
    }
    // a connection string holds the password even though its name has no secret word
    expect(CATALOG.find((e) => e.id === "mongodb")?.env).toMatchObject([{ name: "MDB_MCP_CONNECTION_STRING", secret: true }]);
  });

  it("keeps vendors' own telemetry switched off where the tool offers a switch", () => {
    expect(CATALOG.find((e) => e.id === "xcodebuild")?.env).toEqual([{ name: "XCODEBUILDMCP_SENTRY_DISABLED", secret: false, value: "true" }]);
    expect(CATALOG.find((e) => e.id === "chrome-devtools")?.args).toEqual(expect.arrayContaining(["--no-usage-statistics"]));
  });

  it("gives every entry an icon and every category a name in both languages", () => {
    for (const e of CATALOG) expect(e.icon, e.id).toBeTruthy();
    for (const c of CATEGORIES) {
      expect(enAll[`mcp.catalog.cat.${c}`], c).toBeTruthy();
      expect(huAll[`mcp.catalog.cat.${c}`], c).toBeTruthy();
    }
    expect(new Set(CATALOG.map((e) => e.category))).toEqual(new Set(CATEGORIES));
  });

  it("is bigger than a handful: at least fifteen entries, none of them pointing at a package the registry marks as dropped", () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(15);
    // the reference servers that were archived are not offered
    for (const dropped of ["@modelcontextprotocol/server-github", "@modelcontextprotocol/server-postgres"]) {
      expect(CATALOG.flatMap((e) => e.args ?? []).some((a) => a.startsWith(dropped))).toBe(false);
    }
  });

  it("starts the servers that can write in a read-only mode, or says it is read-only because it only reads", () => {
    expect(CATALOG.find((e) => e.id === "github")?.url).toMatch(/\/readonly$/);
    expect(CATALOG.find((e) => e.id === "mongodb")?.args).toContain("--readOnly");
    for (const id of ["github", "mongodb", "context7", "brave-search", "exa", "perplexity"]) expect(CATALOG.find((e) => e.id === id)?.readOnly, id).toBe(true);
    // Notion, Playwright and Chrome can change things: they are not labelled as reading only
    for (const id of ["notion", "playwright", "chrome-devtools", "firecrawl", "mobile-mcp", "xcodebuild"]) expect(CATALOG.find((e) => e.id === id)?.readOnly, id).toBeUndefined();
  });

  it("keeps the usage statistics of the Chrome server switched off", () => {
    expect(CATALOG.find((e) => e.id === "chrome-devtools")?.args).toEqual(expect.arrayContaining(["--no-usage-statistics", "--no-performance-crux"]));
  });

  it("has an English and a Hungarian summary and setup text for each entry, and no web address in them that the contact check would flag", () => {
    for (const e of CATALOG) {
      for (const key of [e.summary, e.setup]) {
        expect(enAll[key], key).toBeTruthy();
        expect(huAll[key], key).toBeTruthy();
        expect(enAll[key] + huAll[key], key).not.toMatch(/https?:\/\/|www\./);
      }
    }
  });

  it("finds a free name, case-insensitively", () => {
    expect(freeName("github", [])).toBe("github");
    expect(freeName("github", ["GitHub"])).toBe("github-2");
    expect(freeName("github", ["github", "github-2"])).toBe("github-3");
  });

  it("turns an entry into editor rows with the secret boxes ticked and no value anywhere", () => {
    const github = templateOf(CATALOG.find((e) => e.id === "github")!, ["github"]);
    expect(github).toMatchObject({ title: "GitHub", name: "github-2", transport: "http", command: "", args: [] });
    expect(github.url).toBe("https://api.githubcopilot.com/mcp/readonly");
    expect(github.headers).toHaveLength(1);
    expect(github.headers[0]).toMatchObject({ name: "Authorization", secret: true, value: "", secretValue: "", stored: false, existing: false });
    const mongo = templateOf(CATALOG.find((e) => e.id === "mongodb")!, []);
    expect(mongo.args).toEqual(["-y", "mongodb-mcp-server@3.1.0", "--readOnly"]);
    expect(mongo.env[0]).toMatchObject({ name: "MDB_MCP_CONNECTION_STRING", secret: true, secretValue: "" });
    // a second call does not hand out the same row objects (the editor edits them)
    expect(templateOf(CATALOG[0], [])).not.toBe(templateOf(CATALOG[0], []));
  });

  it("shows the exact program line and the variable names the editor will fill in", () => {
    const by = (id: string) => CATALOG.find((e) => e.id === id)!;
    expect(entryLine(by("mongodb"))).toBe("npx -y mongodb-mcp-server@3.1.0 --readOnly");
    expect(entryLine(by("github"))).toBe("https://api.githubcopilot.com/mcp/readonly");
    expect(entryVars(by("xcodebuild"))).toEqual({ secret: [], plain: ["XCODEBUILDMCP_SENTRY_DISABLED"] });
    expect(entryVars(by("notion"))).toEqual({ secret: ["NOTION_TOKEN"], plain: [] });
    // a plain variable the entry sets becomes a filled row; a secret one stays empty
    const row = templateOf(by("xcodebuild"), []).env[0];
    expect(row).toMatchObject({ name: "XCODEBUILDMCP_SENTRY_DISABLED", secret: false, value: "true" });
  });

  it("derives what the person has to bring", () => {
    const by = (id: string) => CATALOG.find((e) => e.id === id)!;
    expect([needsNode(by("github")), needsSecret(by("github"))]).toEqual([false, true]);
    expect([needsNode(by("context7")), needsSecret(by("context7"))]).toEqual([true, false]);
    expect([needsNode(by("figma")), needsSecret(by("figma"))]).toEqual([false, false]);
  });

  it("searches by title, id and summary", () => {
    const github = CATALOG.find((e) => e.id === "github")!;
    expect(matchesCatalog(github, "", "x")).toBe(true);
    expect(matchesCatalog(github, "GIT", "x")).toBe(true);
    expect(matchesCatalog(github, "pull requests", "Read pull requests")).toBe(true);
    expect(matchesCatalog(github, "zzz", "Read pull requests")).toBe(false);
  });
});
