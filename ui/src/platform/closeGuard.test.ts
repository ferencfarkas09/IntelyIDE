import { createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { endSessions, registerUnsavedSource, resetUnsavedSources, saveAllUnsaved, sessionCopy, sessionTitles, unsavedTitles } from "./closeGuard";

afterEach(resetUnsavedSources);

describe("unsaved sources", () => {
  it("lists the unsaved items of every source, reactively", () => {
    const [titles, setTitles] = createSignal(["a.ts"]);
    registerUnsavedSource({ id: "editor", titles, saveAll: async () => true });
    registerUnsavedSource({ id: "other", titles: () => ["notes"], saveAll: async () => true });
    expect(unsavedTitles()).toEqual(["a.ts", "notes"]);
    setTitles([]);
    expect(unsavedTitles()).toEqual(["notes"]);
  });

  it("is saved only when every source ended clean", async () => {
    createRoot(() => undefined);
    registerUnsavedSource({ id: "a", titles: () => [], saveAll: async () => true });
    expect(await saveAllUnsaved()).toBe(true);
    registerUnsavedSource({ id: "b", titles: () => [], saveAll: async () => false });
    expect(await saveAllUnsaved()).toBe(false);
  });
});

describe("session sources", () => {
  it("are live sessions, not unsaved work: they stay out of unsavedTitles and saveAllUnsaved", async () => {
    const end = vi.fn(async () => true);
    registerUnsavedSource({ id: "editor", titles: () => ["a.ts"], saveAll: async () => true });
    registerUnsavedSource({ id: "prod", kind: "session", titles: () => ["Acme production"], saveAll: end, copy: () => ({ title: "t", description: "d", confirm: "c" }) });
    expect(unsavedTitles()).toEqual(["a.ts"]);
    expect(sessionTitles()).toEqual(["Acme production"]);
    expect(await saveAllUnsaved()).toBe(true);
    expect(end).not.toHaveBeenCalled();
  });

  it("endSessions ends every session source and never throws; the copy comes from the first source with something open", async () => {
    const [open, setOpen] = createSignal(["x"]);
    const end = vi.fn(async () => true);
    registerUnsavedSource({ id: "idle", kind: "session", titles: () => [], saveAll: end, copy: () => ({ title: "idle", description: "", confirm: "" }) });
    registerUnsavedSource({ id: "prod", kind: "session", titles: open, saveAll: async () => { throw new Error("boom"); }, copy: () => ({ title: "prod", description: "d", confirm: "c" }) });
    expect(sessionCopy()?.title).toBe("prod");
    await expect(endSessions()).resolves.toBeUndefined();
    expect(end).toHaveBeenCalledTimes(1);
    setOpen([]);
    expect(sessionCopy()).toBeUndefined();
  });
});
