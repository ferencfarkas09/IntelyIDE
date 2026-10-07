import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  mode: "shared" as "shared" | "perRepo",
  checked: { api: ["src/a.ts", "src/b.ts"], web: [] as string[] } as Record<string, string[]>,
  shared: "",
  repos: {} as Record<string, string>,
  draft: (async () => ({})) as (repoId: string, selection: unknown) => Promise<unknown>,
}));

vi.mock("../../ipc", () => ({
  ipc: {
    graph: {
      messageTemplate: async (_style: string, subject?: string) => `${subject ?? "type(scope): description"}\n\nExtended English: \n\nMagyar bővített leírás: \n`,
      draftMessageDetailed: (repoId: string, selection: unknown) => h.draft(repoId, selection),
    },
  },
}));
vi.mock("../../store/selection", () => ({ checkedFiles: (id: string) => h.checked[id] ?? [] }));
vi.mock("../../store/workspace", () => ({ workspace: () => undefined }));
vi.mock("./messageState", () => ({
  messageMode: () => h.mode,
  setRepoMessage: (id: string, text: string) => void (h.repos[id] = text),
  setSharedMessage: (text: string) => void (h.shared = text),
  sharedMessage: () => h.shared,
}));

import { draftingRepo, draftRepoMessage, insertExtendedTemplate, styleOf } from "./generate";

describe("message style helpers", () => {
  it("treats a message with the Extended English paragraph as extended", () => {
    expect(styleOf("feat: x\n\nExtended English: why\n\nMagyar bővített leírás: miért")).toBe("extended");
    expect(styleOf("feat: x\n\nbody mentions Extended English: inline")).toBe("conventional");
    expect(styleOf("")).toBe("conventional");
  });

  it("fills an empty message with the template, appends the sections to typed text and leaves complete messages alone", async () => {
    expect(await insertExtendedTemplate("  ")).toContain("type(scope): description");
    const typed = await insertExtendedTemplate("fix(ui): keep the focus\n\nsome body");
    expect(typed).toBe("fix(ui): keep the focus\n\nsome body\n\nExtended English: \n\nMagyar bővített leírás: \n");
    expect(await insertExtendedTemplate("feat: x\n\nExtended English: y")).toBeNull();
  });
});

describe("draftRepoMessage (one repo block / one repo message field)", () => {
  beforeEach(() => {
    h.mode = "shared";
    h.shared = "";
    h.repos = {};
    h.draft = vi.fn(async (repoId: string) => ({ message: `feat(${repoId}): drafted`, source: "model", issues: [] }));
  });

  it("asks for that repo only, with its ticked paths, and fills its own field in per-repo mode", async () => {
    h.mode = "perRepo";
    await draftRepoMessage("api");
    expect(h.draft).toHaveBeenCalledTimes(1);
    expect(h.draft).toHaveBeenCalledWith("api", [{ path: "src/a.ts" }, { path: "src/b.ts" }]);
    expect(h.repos).toEqual({ api: "feat(api): drafted" });
    expect(h.shared).toBe("");
  });

  it("lets the shared message take the draft of that repo in shared mode", async () => {
    await draftRepoMessage("api");
    expect(h.shared).toBe("feat(api): drafted");
    expect(h.repos).toEqual({});
  });

  it("does nothing for a repo without ticked files", async () => {
    await draftRepoMessage("web");
    expect(h.draft).not.toHaveBeenCalled();
    expect(h.shared).toBe("");
  });

  it("reports busy while the draft is written, ignores a second click, and clears busy after a failure", async () => {
    h.mode = "perRepo";
    let release!: () => void;
    h.draft = vi.fn(() => new Promise((resolve) => (release = () => resolve({ message: "feat: late", source: "model", issues: [] }))));
    const first = draftRepoMessage("api");
    expect(draftingRepo("api")).toBe(true);
    expect(draftingRepo("web")).toBe(false);
    await draftRepoMessage("api");
    expect(h.draft).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(draftingRepo("api")).toBe(false);
    expect(h.repos.api).toBe("feat: late");

    h.draft = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    await draftRepoMessage("api");
    expect(draftingRepo("api")).toBe(false);
    expect(h.repos.api).toBe("feat: late");
  });
});
