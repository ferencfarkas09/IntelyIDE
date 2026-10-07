import { afterEach, describe, expect, it, vi } from "vitest";
import { extensionsFor, registerEditorExtension, resetEditorExtensions } from "./editor-ext";

afterEach(resetEditorExtensions);

describe("editor extensions", () => {
  it("loads only the extensions whose `when` matches the file", async () => {
    const ts = vi.fn(async () => [{ name: "ts" }] as never);
    const md = vi.fn(async () => [{ name: "md" }] as never);
    registerEditorExtension({ id: "ts", when: (f) => f.path.endsWith(".ts"), extension: ts });
    registerEditorExtension({ id: "md", when: (f) => f.path.endsWith(".md"), extension: md });
    expect(await extensionsFor({ repoId: "r", path: "src/a.ts" })).toEqual([[{ name: "ts" }]]);
    expect(md).not.toHaveBeenCalled();
  });

  it("skips an extension that fails to load instead of failing the editor", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    registerEditorExtension({ id: "bad", when: () => true, extension: () => Promise.reject(new Error("chunk")) });
    registerEditorExtension({ id: "good", when: () => true, extension: async () => [] });
    expect(await extensionsFor({ repoId: "r", path: "a" })).toEqual([[]]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
