import { describe, expect, it } from "vitest";
import en from "../../i18n/locales/en/mcp.json";
import hu from "../../i18n/locales/hu/mcp.json";
import { CATALOG, CATEGORIES, freeName, matchesCatalog, needsNode, needsSecret, templateOf } from "./catalog";
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

  it("never carries a value for a secret: variables are names only, and any token-looking name is marked secret", () => {
    for (const e of CATALOG) {
      for (const v of [...(e.env ?? []), ...(e.headers ?? [])]) {
        expect(Object.keys(v).sort(), `${e.id} ${v.name}`).toEqual(["name", "secret"]);
        if (isSecretName(v.name)) expect(v.secret, `${e.id} ${v.name}`).toBe(true);
      }
      expect((e.args ?? []).filter((a) => a.includes("=")), `${e.id} has a value in its arguments`).toEqual([]);
      expect(e.url ?? "", e.id).not.toMatch(/@|\?/);
    }
    // a connection string holds the password even though its name has no secret word
    expect(CATALOG.find((e) => e.id === "mongodb")?.env).toEqual([{ name: "MDB_MCP_CONNECTION_STRING", secret: true }]);
  });

  it("starts the servers that can write in a read-only mode, or says it is read-only because it only reads", () => {
    expect(CATALOG.find((e) => e.id === "github")?.url).toMatch(/\/readonly$/);
    expect(CATALOG.find((e) => e.id === "mongodb")?.args).toContain("--readOnly");
    for (const id of ["github", "mongodb", "context7", "brave-search"]) expect(CATALOG.find((e) => e.id === id)?.readOnly, id).toBe(true);
    // Notion, Playwright and Chrome can change things: they are not labelled as reading only
    for (const id of ["notion", "playwright", "chrome-devtools"]) expect(CATALOG.find((e) => e.id === id)?.readOnly, id).toBeUndefined();
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
