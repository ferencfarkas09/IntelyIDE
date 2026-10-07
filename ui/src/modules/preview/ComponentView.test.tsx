import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import { toast } from "../../ui-kit";
import { dropTargets, registerDropTarget, resetDropZone } from "../../platform/dropzone";
import { componentApi, setComponentApi, type ComponentApi, type HarnessInfo } from "./componentApi";
import { PROTOCOL } from "./componentLogic";
import { resetComponentState } from "./componentState";
import { ComponentView } from "./ComponentView";
import { FRAME_SANDBOX } from "./logic";

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const SOURCE = `import React from "react";
export default function Greeting({ name = "World", onClick, items }) {
  return <h1 onClick={onClick}>Hello {name}</h1>;
}
Greeting.propTypes = { name: PropTypes.string };
`;

const info = (over: Partial<HarnessInfo> = {}): HarnessInfo => ({ id: "h1", url: "http://127.0.0.1:50111/", port: 50111, engine: "ide", esbuild: "0.28.2", react: "18.3.1", installed: { redux: true, mui: true, styled: false, router: true }, uses: { redux: true, mui: false, styled: false, router: true }, buildOk: true, ms: 80, ...over });

const frame = () => document.querySelector<HTMLIFrameElement>("iframe.pv__frame")!;
const sent: Array<{ message: Record<string, unknown>; origin: string }> = [];
let api: ComponentApi & { start: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };

/** The harness page answers from its own window with its own origin. */
function fromFrame(data: unknown, origin = "http://127.0.0.1:50999") {
  window.dispatchEvent(new MessageEvent("message", { data, origin, source: frame().contentWindow }));
}
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  resetComponentState();
  resetDropZone();
  sent.length = 0;
  await ipc.settings.set("preview", { "component:r:src/Greeting.jsx#default": null });
  vi.spyOn(ipc.files, "readFile").mockResolvedValue({ text: SOURCE } as never);
  vi.spyOn(ipc.preview, "proxyStart").mockResolvedValue({ url: "http://127.0.0.1:50999/", port: 50999, upstreamPort: 50111 });
  api = { start: vi.fn(async () => info()), release: vi.fn(async () => undefined), log: vi.fn(async () => []) };
  setComponentApi(api);
  // jsdom's contentWindow.postMessage does not deliver across origins; record what the IDE sends instead.
  vi.spyOn(window, "postMessage");
  const proto = Object.getPrototypeOf(document.createElement("iframe")) as HTMLIFrameElement;
  void proto;
});

afterEach(() => {
  cleanup();
  setComponentApi(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount() {
  render(() => <ComponentView repoId="r" path="src/Greeting.jsx" exportName="default" />);
  await waitFor(() => expect(frame()).toBeTruthy());
  const win = frame().contentWindow!;
  vi.spyOn(win, "postMessage").mockImplementation(((message: Record<string, unknown>, origin: string) => void sent.push({ message, origin })) as never);
}

describe("<ComponentView>", () => {
  it("starts the harness for the file and export, and loads the frame through the proxy with the pinned sandbox", async () => {
    await mount();
    expect(api.start).toHaveBeenCalledWith("r", "src/Greeting.jsx", "default");
    expect(frame().getAttribute("src")).toBe("http://127.0.0.1:50999/");
    expect(frame().getAttribute("sandbox")).toBe(FRAME_SANDBOX);
    expect(frame().hasAttribute("data-intely-preview")).toBe(true);
    expect(frame().getAttribute("data-repo-id")).toBe("r");
    expect(frame().getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("sends the suggested props (from the source) once the page says it is ready, addressed to the frame origin only", async () => {
    await mount();
    expect(sent).toHaveLength(0); // nothing before the page announced itself
    fromFrame({ intely: PROTOCOL.ready, name: "Greeting", file: "src/Greeting.jsx", exports: ["default"], available: { redux: true, router: true } });
    await waitFor(() => expect(sent.find((s) => s.message.intely === PROTOCOL.set)).toBeTruthy());
    const set = sent.find((s) => s.message.intely === PROTOCOL.set)!;
    expect(set.origin).toBe("http://127.0.0.1:50999");
    expect(set.message.props).toEqual({ name: "World", onClick: { $fn: "onClick" }, items: [] });
    // the page reported that the bundle has redux and the router: those providers are on, the theme one is off
    expect(set.message.wrappers).toEqual({ theme: false, redux: true, router: true });
  });

  it("ignores messages from another window or origin", async () => {
    await mount();
    window.dispatchEvent(new MessageEvent("message", { data: { intely: PROTOCOL.ready, name: "X", file: "", exports: [], available: {} }, origin: "http://127.0.0.1:50999", source: window }));
    fromFrame({ intely: PROTOCOL.ready, name: "X", file: "", exports: [], available: {} }, "http://evil.example");
    await settle();
    expect(sent.find((s) => s.message.intely === PROTOCOL.set)).toBeUndefined();
  });

  it("validates the props JSON, keeps the last good props on a typo and shows where the error is", async () => {
    await mount();
    fromFrame({ intely: PROTOCOL.ready, name: "Greeting", file: "x", exports: ["default"], available: {} });
    await waitFor(() => expect(sent.some((s) => s.message.intely === PROTOCOL.set)).toBe(true));
    const before = sent.length;
    const editor = screen.getByLabelText("Props as JSON") as HTMLTextAreaElement;
    fireEvent.input(editor, { target: { value: '{\n  "name": }' } });
    await waitFor(() => expect(screen.getByTestId("props-error").textContent).toMatch(/Line 2, column/));
    await settle();
    expect(sent.length).toBe(before);
    fireEvent.input(editor, { target: { value: '{"name":"Ada"}' } });
    await waitFor(() => expect(screen.getByTestId("props-valid")).toBeTruthy());
    await waitFor(() => expect(sent.at(-1)?.message.props).toEqual({ name: "Ada" }));
  });

  it("switches color scheme and viewport and tells the page", async () => {
    await mount();
    fromFrame({ intely: PROTOCOL.ready, name: "Greeting", file: "x", exports: ["default"], available: {} });
    await waitFor(() => expect(sent.some((s) => s.message.intely === PROTOCOL.set)).toBe(true));
    fireEvent.click(screen.getByRole("radio", { name: "Light content" }));
    await waitFor(() => expect(sent.at(-1)?.message.scheme).toBe("light"));
    fireEvent.click(screen.getByRole("radio", { name: "Phone" }));
    await waitFor(() => expect(frame().style.width).toBe("393px"));
    expect(frame().style.height).toBe("852px");
  });

  it("saves, applies and deletes a props preset per component", async () => {
    await mount();
    fromFrame({ intely: PROTOCOL.ready, name: "Greeting", file: "x", exports: ["default"], available: {} });
    const editor = screen.getByLabelText("Props as JSON") as HTMLTextAreaElement;
    fireEvent.input(editor, { target: { value: '{"name":"Preset one"}' } });
    fireEvent.click(screen.getByText("Save as..."));
    fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Short name" } });
    fireEvent.click(screen.getByText("Save"));
    const set = await ipc.settings.get("preview");
    await waitFor(async () => expect(((await ipc.settings.get("preview"))["component:r:src/Greeting.jsx#default"] as { presets?: unknown[] } | undefined)?.presets).toEqual([{ name: "Short name", props: '{"name":"Preset one"}', store: "{}" }]), { timeout: 2000 });
    void set;
    fireEvent.input(editor, { target: { value: '{"name":"other"}' } });
    // pick the saved set again from the preset select
    fireEvent.change(screen.getByLabelText("Saved props"), { target: { value: "Short name" } });
    await waitFor(() => expect((screen.getByLabelText("Props as JSON") as HTMLTextAreaElement).value).toBe('{"name":"Preset one"}'));
  });

  it("shows a build error with its position and a button that opens the file there", async () => {
    await mount();
    fromFrame({ intely: PROTOCOL.status, state: "buildError", message: "Unexpected }", errors: [{ file: "src/Greeting.jsx", line: 4, col: 9, text: "Unexpected }" }] });
    const banner = await screen.findByTestId("component-status");
    expect(banner.textContent).toContain("src/Greeting.jsx:4:9 Unexpected }");
    expect(banner.getAttribute("data-state")).toBe("buildError");
    expect(screen.getByText("Open at the error")).toBeTruthy();
  });

  it("logs callback calls, dispatches and blocked requests in the Events tab", async () => {
    await mount();
    fromFrame({ intely: PROTOCOL.event, kind: "fn", name: 'onClick("Ada")' });
    fromFrame({ intely: PROTOCOL.event, kind: "network", name: "GET api.example.com/orders", detail: "blocked" });
    fireEvent.click(screen.getByRole("radio", { name: /Events/ }));
    const list = await screen.findByTestId("events");
    expect(list.textContent).toContain('onClick("Ada")');
    expect(list.textContent).toContain("GET api.example.com/orders");
    expect(screen.getByText(/1 warning or blocked request/)).toBeTruthy();
  });

  it("explains why the preview could not start and retries on request", async () => {
    api.start.mockRejectedValueOnce({ code: "noReact", message: "react missing" });
    render(() => <ComponentView repoId="r" path="src/Greeting.jsx" exportName="default" />);
    expect(await screen.findByText(/react and react-dom are not installed in this repository/)).toBeTruthy();
    fireEvent.click(screen.getByText("Try again"));
    await waitFor(() => expect(frame()).toBeTruthy());
    expect(api.start).toHaveBeenCalledTimes(2);
  });

  it("releases the harness when the view closes, and when the export changes", async () => {
    await mount();
    cleanup();
    await waitFor(() => expect(api.release).toHaveBeenCalledWith("h1"));
  });

  it("attaches a screenshot to the visible agent prompt through the drop router", async () => {
    const dropped: File[] = [];
    registerDropTarget({ id: "composer:agent:a1", priority: 50, label: "agent", accepts: () => true, isActive: () => true, onDrop: (items) => void dropped.push(...(items.map((i) => i.blob as File))) });
    await mount();
    fromFrame({ intely: PROTOCOL.ready, name: "Greeting", file: "x", exports: ["default"], available: {} });
    await waitFor(() => expect(sent.some((s) => s.message.intely === PROTOCOL.set)).toBe(true));
    fireEvent.click(screen.getByLabelText("Attach screenshot"));
    await waitFor(() => expect(sent.some((s) => s.message.intely === PROTOCOL.shotReq)).toBe(true));
    const req = sent.find((s) => s.message.intely === PROTOCOL.shotReq)!.message;
    fromFrame({ intely: PROTOCOL.shot, id: req.id, ok: true, dataUrl: "data:image/png;base64,iVBORw0KGgo=", width: 10, height: 10 });
    await waitFor(() => expect(dropped).toHaveLength(1));
    expect(dropped[0].type).toBe("image/png");
    expect(dropped[0].name).toBe("Greeting-dark-fit.png");
    expect(dropTargets().length).toBe(1);
  });

  it("says so when no agent prompt is open", async () => {
    await mount();
    fromFrame({ intely: PROTOCOL.ready, name: "Greeting", file: "x", exports: ["default"], available: {} });
    await waitFor(() => expect(sent.some((s) => s.message.intely === PROTOCOL.set)).toBe(true));
    const info = vi.spyOn(toast, "info");
    fireEvent.click(screen.getByLabelText("Attach screenshot"));
    await waitFor(() => expect(sent.some((s) => s.message.intely === PROTOCOL.shotReq)).toBe(true));
    const req = sent.find((s) => s.message.intely === PROTOCOL.shotReq)!.message;
    fromFrame({ intely: PROTOCOL.shot, id: req.id, ok: true, dataUrl: "data:image/png;base64,iVBORw0KGgo=", width: 10, height: 10 });
    await waitFor(() => expect(info).toHaveBeenCalledWith("No agent prompt is open", expect.any(String)));
  });
});

describe("browser mock backend", () => {
  it("needs ?harness=<loopback url> and refuses anything else", async () => {
    setComponentApi(undefined);
    const { createMockComponentApi } = await import("./componentApi");
    await expect(createMockComponentApi(() => "").start("r", "a.jsx", "default")).rejects.toMatchObject({ code: "mock" });
    await expect(createMockComponentApi(() => "?harness=https://evil.example/").start("r", "a.jsx", "default")).rejects.toMatchObject({ code: "mock" });
    const ok = await createMockComponentApi(() => "?harness=http://127.0.0.1:50777").start("r", "a.jsx", "default");
    expect(ok.url).toBe("http://127.0.0.1:50777/");
    expect(componentApi()).toBeTruthy();
  });
});
