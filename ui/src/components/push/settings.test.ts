import { beforeEach, describe, expect, it, vi } from "vitest";

// The settings only need the storage helpers; importing the whole kit for every fresh module would be slow.
vi.mock("../../ui-kit", () => ({
  readStored: (key: string) => localStorage.getItem(key),
  writeStored: (key: string, value: string) => localStorage.setItem(key, value),
}));

async function fresh() {
  vi.resetModules();
  return import("./settings");
}

beforeEach(() => localStorage.clear());

describe("push options persistence", () => {
  it("keeps harmless options across a restart", async () => {
    const a = await fresh();
    a.setPushTags("follow");
    a.setPreviewNonProtected(false);
    const b = await fresh();
    expect(b.pushTags()).toBe("follow");
    expect(b.previewNonProtected()).toBe(false);
  });

  it("applies hooks off and all tags to the current session only", async () => {
    const a = await fresh();
    a.setRunGitHooks(false);
    a.setPushTags("all");
    expect(a.runGitHooks()).toBe(false);
    expect(a.pushTags()).toBe("all");
    const b = await fresh();
    expect(b.runGitHooks()).toBe(true);
    expect(b.pushTags()).toBe("none");
  });

  it("ignores values stored by an earlier version", async () => {
    localStorage.setItem("intely.push.options", JSON.stringify({ tags: "all", runHooks: false, previewNonProtected: true }));
    const a = await fresh();
    expect(a.runGitHooks()).toBe(true);
    expect(a.pushTags()).toBe("none");
  });
});
