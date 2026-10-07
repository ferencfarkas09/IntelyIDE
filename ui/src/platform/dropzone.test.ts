import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseTarget, dropItems, dropState, endDrag, handleNativeDrag, installDropRouter, itemFromFile, itemFromPath, registerDropTarget, resetDropZone, type DropItem, type DropTarget } from "./dropzone";

const img = itemFromPath("/Users/me/Desktop/Screenshot 1.png");
const file = itemFromPath("/Users/me/notes.md");

const target = (over: Partial<DropTarget> & { id: string }): DropTarget => ({ priority: 10, label: over.id, accepts: () => true, isActive: () => true, onDrop: vi.fn(), ...over });
const at = (x: number, y: number, w: number, h: number): (() => HTMLElement) => () => ({ getBoundingClientRect: () => ({ left: x, top: y, width: w, height: h }) }) as unknown as HTMLElement;

beforeEach(() => resetDropZone());
afterEach(() => resetDropZone());

describe("normalisation", () => {
  it("classifies native paths by extension and keeps the real path", () => {
    expect(img).toMatchObject({ kind: "image", name: "Screenshot 1.png", mime: "image/png", path: "/Users/me/Desktop/Screenshot 1.png" });
    expect(file).toMatchObject({ kind: "file", name: "notes.md", mime: "text/markdown" });
  });
  it("wraps File objects with their blob", () => {
    const f = new File(["abc"], "a.png", { type: "image/png" });
    expect(itemFromFile(f)).toMatchObject({ kind: "image", name: "a.png", size: 3, blob: f });
  });
});

describe("target choice", () => {
  it("takes the highest priority among active, accepting targets", () => {
    const a = target({ id: "low", priority: 10 });
    const b = target({ id: "high", priority: 90 });
    const c = target({ id: "off", priority: 99, isActive: () => false });
    const d = target({ id: "no", priority: 98, accepts: () => false });
    expect(chooseTarget([img], undefined, [a, b, c, d]).target?.id).toBe("high");
  });
  it("prefers the target under the pointer over a higher priority one", () => {
    const composer = target({ id: "composer", priority: 100, element: at(0, 500, 400, 100) });
    const terminal = target({ id: "terminal", priority: 30, element: at(0, 300, 400, 150) });
    expect(chooseTarget([file], { x: 50, y: 350 }, [composer, terminal]).target?.id).toBe("terminal");
    expect(chooseTarget([file], { x: 50, y: 20 }, [composer, terminal]).target?.id).toBe("composer");
  });
  it("lets an ignoring area swallow the drop", () => {
    const composer = target({ id: "composer", priority: 100 });
    const commit = target({ id: "commit", ignores: true, hint: "No files here", element: at(0, 0, 200, 100) });
    const c = chooseTarget([file], { x: 10, y: 10 }, [composer, commit]);
    expect(c.target).toBeUndefined();
    expect(c.ignored?.id).toBe("commit");
  });
  it("has no target when nothing accepts", () => {
    expect(chooseTarget([file], undefined, [target({ id: "x", accepts: () => false })]).target).toBeUndefined();
  });
});

describe("native drag-drop (Tauri)", () => {
  it("shows the overlay state with the chosen target while dragging and clears it on leave", async () => {
    registerDropTarget(target({ id: "composer", label: "the agent composer", priority: 50 }));
    await handleNativeDrag({ type: "enter", paths: [img.path!, file.path!], position: { x: 20, y: 20 } }, 1);
    expect(dropState()).toMatchObject({ active: true, target: { id: "composer", label: "the agent composer" } });
    expect(dropState().items.map((i) => i.name)).toEqual(["Screenshot 1.png", "notes.md"]);
    await handleNativeDrag({ type: "leave" });
    expect(dropState().active).toBe(false);
  });
  it("explains why nothing takes the drop (provider without attachments)", async () => {
    registerDropTarget(target({ id: "composer", accepts: () => false, refusal: () => "Anthropic does not take attachments" }));
    await handleNativeDrag({ type: "enter", paths: [img.path!], position: { x: 1, y: 1 } }, 1);
    expect(dropState().target).toBeUndefined();
    expect(dropState().hint).toBe("Anthropic does not take attachments");
  });
  it("converts physical to CSS pixels and delivers every dropped path to the target", async () => {
    const onDrop = vi.fn();
    registerDropTarget(target({ id: "terminal", priority: 1, element: at(0, 0, 100, 100), onDrop }));
    registerDropTarget(target({ id: "composer", priority: 100 }));
    await handleNativeDrag({ type: "drop", paths: ["/a/one.txt", "/a/two.png"], position: { x: 100, y: 100 } }, 2); // (50,50) css: inside the terminal
    expect(onDrop).toHaveBeenCalledOnce();
    expect((onDrop.mock.calls[0][0] as DropItem[]).map((i) => i.path)).toEqual(["/a/one.txt", "/a/two.png"]);
    expect(dropState().active).toBe(false);
  });
  it("reports an unhandled drop when no target exists", async () => {
    expect(await dropItems([file])).toEqual({ handled: false });
  });
  it("survives a failing target", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    registerDropTarget(target({ id: "bad", onDrop: () => { throw new Error("boom"); } }));
    expect((await dropItems([file])).handled).toBe(false);
    err.mockRestore();
  });
});

describe("HTML5 source (browser, mock UI)", () => {
  it("routes a drop with real File objects and tracks dragover state", async () => {
    const off = installDropRouter();
    const onDrop = vi.fn();
    registerDropTarget(target({ id: "composer", onDrop }));
    const f = new File(["hello"], "hello.txt", { type: "text/plain" });
    const dt = { types: ["Files"], files: [f], items: [{ kind: "file", type: "text/plain" }], getData: () => "" } as unknown as DataTransfer;
    const ev = (type: string) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), { dataTransfer: dt, clientX: 5, clientY: 5 });
    window.dispatchEvent(ev("dragenter"));
    expect(dropState().active).toBe(true);
    expect(dropState().provisional).toBe(true);
    window.dispatchEvent(ev("drop"));
    await vi.waitFor(() => expect(onDrop).toHaveBeenCalledOnce());
    expect((onDrop.mock.calls[0][0] as DropItem[])[0]).toMatchObject({ name: "hello.txt", blob: f });
    expect(dropState().active).toBe(false);
    off();
  });
  it("ignores drags that carry no files and exposes the test hook", async () => {
    const off = installDropRouter();
    window.dispatchEvent(Object.assign(new Event("dragenter", { cancelable: true }), { dataTransfer: { types: ["text/plain"], items: [], files: [] } }));
    expect(dropState().active).toBe(false);
    const onDrop = vi.fn();
    registerDropTarget(target({ id: "t", onDrop }));
    await (window as unknown as { __intelyDrop: { native: typeof handleNativeDrag } }).__intelyDrop.native({ type: "drop", paths: ["/x/y.txt"], position: { x: 0, y: 0 } }, 1);
    expect(onDrop).toHaveBeenCalledOnce();
    off();
    endDrag();
  });
});
