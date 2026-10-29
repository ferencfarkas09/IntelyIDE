import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import enCatalog from "../../i18n/locales/en/prompts.json";
import huCatalog from "../../i18n/locales/hu/prompts.json";
import { installDomStubs } from "../../store/testing-u2";
import type { NewRunSlotContext } from "../../platform/newRunSlots";
import { allTags, exportJson, fillPrompt, libraryFor, normalizePrompt, parseImport, parseTags, placeholdersIn, readSettings, searchPrompts, upsert } from "./logic";
import PromptPicker, { insertInto } from "./PromptPicker";
import { STARTER_IDS, starterPrompts } from "./starters";
import { resetPromptsStore } from "./store";
import type { SavedPrompt } from "./types";

installDomStubs();
afterEach(() => {
  cleanup();
  resetPromptsStore();
});

const p = (id: string, title: string, body = "body", tags: string[] = []): SavedPrompt => ({ id, title, body, tags, updatedAt: 1 });

describe("placeholders", () => {
  it("fills the four placeholders in any case and leaves a note for what is not known", () => {
    expect(placeholdersIn("{{file}} {{ Branch }} {{file}} {{x}}")).toEqual(["file", "branch"]);
    expect(fillPrompt("Fix {{file}} on {{ BRANCH }} in {{repo}}: {{selection}}", { file: "src/App.tsx", branch: "main" })).toBe("Fix src/App.tsx on main in <repo>: <selection>");
    expect(fillPrompt("{{unknown}} stays", {})).toBe("{{unknown}} stays");
  });

  it("puts a selection of several lines into a code block", () => {
    expect(fillPrompt("Explain:\n{{selection}}", { selection: "a\nb\n" })).toBe("Explain:\n\n```\na\nb\n```\n");
  });
});

describe("search and storage", () => {
  const list = [p("1", "Add tests", "write jest tests", ["react", "test"]), p("2", "Dark mode", "use the tokens in tests", ["css"]), p("3", "Explain")];
  it("matches every word in the title, tags or body, title and tag matches first", () => {
    expect(searchPrompts(list, "test").map((x) => x.id)).toEqual(["1", "2"]);
    expect(searchPrompts(list, "react tests").map((x) => x.id)).toEqual(["1"]);
    expect(searchPrompts(list, "  ").length).toBe(3);
    expect(allTags(list)).toEqual(["css", "react", "test"]);
  });

  it("reads only well-formed prompts from settings and never lets one pose as a starter", () => {
    const s = readSettings({ user: [{ title: "A", body: "b" }, { title: "", body: "x" }, "junk", { id: "starter:explain", title: "T", body: "B" }], repos: { web: [{ title: "W", body: "w", tags: ["React", "react", 3] }], empty: [], bad: "x" } });
    expect(s.user.map((x) => x.title)).toEqual(["A", "T"]);
    expect(s.user[1].id).not.toMatch(/^starter:/);
    expect(Object.keys(s.repos)).toEqual(["web"]);
    expect(s.repos.web[0].tags).toEqual(["react"]);
  });

  it("keeps tags short, lower case and unique", () => {
    expect(parseTags("React, test  ui,react")).toEqual(["react", "test", "ui"]);
    expect(parseTags("a ".repeat(40)).length).toBe(1);
    expect(normalizePrompt({ title: "x".repeat(500), body: "b" })!.title.length).toBe(120);
  });

  it("replaces a prompt with the same id and adds a new one at the start", () => {
    expect(upsert([p("1", "a"), p("2", "b")], p("2", "B")).map((x) => x.title)).toEqual(["a", "B"]);
    expect(upsert([p("1", "a")], p("9", "z")).map((x) => x.id)).toEqual(["9", "1"]);
  });

  it("exports titles, bodies and tags only, and an import gets new ids", () => {
    const json = exportJson([p("secret-id", "T", "B", ["x"])]);
    expect(json).not.toContain("secret-id");
    const back = parseImport(json);
    expect("prompts" in back && back.prompts[0]).toMatchObject({ title: "T", body: "B", tags: ["x"] });
    expect("prompts" in back && back.prompts[0].id).not.toBe("secret-id");
    expect(parseImport("[{\"title\":\"a\",\"body\":\"b\"},{\"nope\":1}]")).toMatchObject({ skipped: 1 });
    expect(parseImport("{")).toEqual({ error: "json" });
    expect(parseImport("{\"x\":1}")).toEqual({ error: "shape" });
    expect(parseImport(JSON.stringify(Array.from({ length: 501 }, () => ({ title: "a", body: "b" }))))).toEqual({ error: "tooMany" });
  });

  it("lists the repository's prompts, then the person's, then the starters", () => {
    const lib = libraryFor({ user: [p("u", "Mine")], repos: { web: [p("r", "Web only")], api: [p("a", "Api only")] } }, ["web"], starterPrompts());
    expect(lib.slice(0, 2).map((x) => x.id)).toEqual(["r", "u"]);
    expect(lib.some((x) => x.id === "a")).toBe(false);
    expect(lib[2].scope.kind).toBe("starter");
  });
});

describe("starters", () => {
  it("cover the stack and every one has an English and a Hungarian title", () => {
    const en: Record<string, string> = enCatalog;
    const hu: Record<string, string> = huCatalog;
    expect(STARTER_IDS.length).toBe(22);
    for (const id of STARTER_IDS) {
      expect(en[`prompts.starter.${id}`], id).toBeTruthy();
      expect(hu[`prompts.starter.${id}`], id).toBeTruthy();
    }
    for (const s of starterPrompts()) if (!/^(explain|review|commit-message)$/.test(s.id.slice(8))) expect(s.body, s.id).toContain("Do not commit or push.");
  });
});

describe("the picker in the New Run dialog", () => {
  it("puts the filled prompt into the box, after what is already there", async () => {
    expect(insertInto("", "x")).toBe("x");
    expect(insertInto("first\n\n", "x")).toBe("first\n\nx");
    let text = "Hello";
    const setPrompt = vi.fn((v: string) => (text = v));
    const ctx: NewRunSlotContext = { prompt: () => text, setPrompt, repoIds: () => [], permission: () => "edit", pickMode: () => {}, supported: () => [], unavailable: () => ({}), disabled: () => false };
    render(() => <PromptPicker ctx={ctx} />);
    fireEvent.click(screen.getByRole("button", { name: "Saved prompts" }));
    fireEvent.click(await screen.findByText("Explain this code in plain language"));
    await waitFor(() => expect(setPrompt).toHaveBeenCalled());
    expect(text.startsWith("Hello\n\nExplain this code in plain language")).toBe(true);
    expect(text).toContain("<selection>");
  });
});
