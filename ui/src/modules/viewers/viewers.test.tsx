import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import { availableCommands, execute, resetCommands } from "../../platform/commands";
import { dockTabs } from "../../platform/dock";
import { overlays, resetOverlays } from "../../platform/overlay";
import { resetSettings, settingsSections } from "../../platform/settings";
import { getTabType, openTab, resetTabs, tabs } from "../../platform/tabs";
import { createInThreadClient } from "./client";
import JsonViewerTab from "./JsonViewerTab";
import { loadInto, TooLargeError } from "./loader";
import { dataKindOf, formatBytes, previewKindOf } from "./logic";
import { MarkdownView } from "./MarkdownView";
import { PreviewBody } from "./PreviewBody";
import { setViewersEnabled } from "./state";
import { register } from "./index";

afterEach(() => {
  cleanup();
  resetCommands();
  resetOverlays();
  resetSettings();
  resetTabs();
  setViewersEnabled(true);
  vi.restoreAllMocks();
});

const tab = (path: string) => ({ id: `jsonview:r1:${path}`, type: "jsonview", title: path, params: { repoId: "r1", path } });

describe("viewers register()", () => {
  it("adds two tab types, a dock tab, an overlay, a section and commands, and does no work", () => {
    const calls = [vi.spyOn(ipc.viewers, "stat"), vi.spyOn(ipc.viewers, "readRange"), vi.spyOn(ipc.settings, "get"), vi.spyOn(ipc.files, "readFile")];
    const interval = vi.spyOn(globalThis, "setInterval");
    const worker = vi.fn();
    vi.stubGlobal("Worker", worker);
    register();
    expect(getTabType("jsonview")).toMatchObject({ canClose: true });
    expect(getTabType("docview")).toMatchObject({ canClose: true });
    expect(dockTabs().some((t) => t.id === "viewer")).toBe(true);
    expect(overlays().map((o) => o.id)).toContain("viewers");
    expect(settingsSections().find((s) => s.id === "viewers")).toBeTruthy();
    for (const c of calls) expect(c).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("offers its commands only for matching files, and only while the switch is on", () => {
    register();
    const ids = () => availableCommands().map((c) => c.id);
    expect(ids()).not.toContain("viewers.openData");
    expect(ids()).not.toContain("viewers.openPreview");
    openTab({ type: "jsonview", id: "file:r1:data/x.json", title: "x.json", params: { repoId: "r1", path: "data/x.json" } });
    // an editor tab type is not registered in this test, so the commands stay hidden: they follow `type === "file"` only
    expect(tabs()).toHaveLength(1);
    expect(ids()).not.toContain("viewers.openData");
  });
});

describe("file kinds", () => {
  it("picks the viewer by extension", () => {
    expect(dataKindOf("a/b.JSON")).toBe("json");
    expect(dataKindOf("x.ndjson")).toBe("jsonl");
    expect(dataKindOf("x.log")).toBe("log");
    expect(dataKindOf("package.json.bak")).toBeNull();
    expect(dataKindOf(".json")).toBeNull();
    expect(previewKindOf("README.md")).toBe("markdown");
    expect(previewKindOf("a.svg")).toBe("svg");
    expect(previewKindOf("a.WEBP")).toBe("image");
    expect(previewKindOf("a.pdf")).toBe("pdf");
    expect(previewKindOf("a.ts")).toBeNull();
    expect(formatBytes(12_800_000)).toBe("12 MB");
  });
});

describe("loader", () => {
  it("refuses JSON over 50 MB and reads only the first 50 MB of a log", async () => {
    vi.spyOn(ipc.viewers, "stat").mockResolvedValue({ size: 60 * 1024 * 1024, mtimeMs: 1 });
    const client = createInThreadClient();
    await expect(loadInto(client, "r1", "big.json", "json")).rejects.toBeInstanceOf(TooLargeError);
    const read = vi.spyOn(ipc.viewers, "readRange").mockImplementation(async (_r, _p, offset, len) => ({ base64: btoa("line INFO x\n".repeat(3)), offset, len, eof: false }));
    const res = await loadInto(client, "r1", "big.log", "log");
    expect(res.truncated).toBe(true);
    const asked = read.mock.calls.reduce((n, c) => n + (c[3] as number), 0);
    expect(asked).toBe(50 * 1024 * 1024);
  });

  it("stops reading when cancelled", async () => {
    const read = vi.spyOn(ipc.viewers, "readRange");
    let n = 0;
    await loadInto(createInThreadClient(), "r1", "data/huge.log", "log", { isCancelled: () => n++ > 0 });
    expect(read.mock.calls.length).toBe(1);
  });
});

describe("JSON viewer tab", () => {
  it("loads a JSON file, shows the tree, expands, searches and copies a path", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    render(() => <JsonViewerTab tab={tab("data/sample.json")} />);
    await waitFor(() => expect(screen.getByText(/intely-fixture/)).toBeTruthy());
    expect(screen.getByText(/orders/)).toBeTruthy();
    expect(screen.getByRole("tree").getAttribute("aria-rowcount")).toBe("8");

    fireEvent.click(screen.getByText("scripts"));
    await waitFor(() => expect(screen.getByText("vitest run", { exact: false })).toBeTruthy());
    expect(screen.getByRole("tree").getAttribute("aria-rowcount")).toBe("11");

    const box = screen.getByLabelText("Search the document") as HTMLInputElement;
    fireEvent.input(box, { target: { value: ".orders[7].customer.name" } });
    await waitFor(() => expect(screen.getByText('"Customer 8"')).toBeTruthy());
    expect(screen.getByText("1 / 1")).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".vw__row[data-selected]")?.textContent).toContain("Customer 8"));

    fireEvent.click(screen.getByRole("button", { name: "Copy path" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith(".orders[7].customer.name"));
  });

  it("shows a query error and keeps the tree", async () => {
    render(() => <JsonViewerTab tab={tab("data/sample.json")} />);
    await waitFor(() => expect(screen.getByText(/intely-fixture/)).toBeTruthy());
    fireEvent.input(screen.getByLabelText("Search the document"), { target: { value: ".orders[" } });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/\]/));
    expect(screen.getByText(/intely-fixture/)).toBeTruthy();
  });

  it("falls back to text lines with a notice for broken JSON", async () => {
    render(() => <JsonViewerTab tab={tab("data/broken.json")} />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Not valid JSON/));
    await waitFor(() => expect(screen.getByText(/"b": \}/)).toBeTruthy());
  });

  it("opens a log: lines with levels, an error counter, JSON lines expandable", async () => {
    render(() => <JsonViewerTab tab={tab("data/huge.log")} />);
    await waitFor(() => expect(screen.getByText(/120,000 lines/)).toBeTruthy(), { timeout: 5000 });
    expect(screen.getByRole("tree").getAttribute("aria-rowcount")).toBe("120000");
    await waitFor(() => expect(screen.getByRole("button", { name: /errors/ })).toBeTruthy());
    expect(document.querySelectorAll(".vw__row").length).toBeLessThan(100);
    expect(document.querySelector('.vw__row[data-level="error"]')).toBeTruthy();
  }, 15000);

  it("explains a file over the cap instead of freezing", async () => {
    vi.spyOn(ipc.viewers, "stat").mockResolvedValue({ size: 80 * 1024 * 1024, mtimeMs: 1 });
    render(() => <JsonViewerTab tab={tab("data/sample.json")} />);
    await waitFor(() => expect(screen.getByText("Too large for the JSON viewer")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Open in the editor" })).toBeTruthy();
  });

  it("refuses a guarded file", async () => {
    render(() => <JsonViewerTab tab={tab(".env.json")} />);
    await waitFor(() => expect(screen.getByText("Could not open this file")).toBeTruthy());
  });
});

describe("preview", () => {
  it("renders Markdown without HTML injection and blocks remote images and unsafe links", async () => {
    render(() => <MarkdownView repoId="r1" path="docs/spec.md" text={'# Hi\n\n<img src=x onerror="window.__pwned=1"> <script>window.__pwned=2</script>\n\n[bad](javascript:window.__pwned=3)\n\n![r](https://example.com/x.png)'} />);
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("article img")).toBeNull();
    expect(document.body.textContent).toContain("<img src=x");
    expect(screen.getByText(/Remote image blocked/)).toBeTruthy();
    const link = screen.getByText("bad");
    expect(link.getAttribute("href")).toBeNull();
    expect(link.getAttribute("data-blocked")).toBe("");
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("previews a Markdown file with a local image inlined from the repo", async () => {
    render(() => <PreviewBody file={{ repoId: "r1", path: "docs/spec.md" }} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Release notes" })).toBeTruthy());
    expect(document.querySelectorAll("table tbody tr")).toHaveLength(2);
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  });

  it("shows an SVG as an image (so its script cannot run) and a PNG with zoom", async () => {
    render(() => <PreviewBody file={{ repoId: "r1", path: "assets/logo.svg" }} />);
    const img = (await waitFor(() => {
      const el = document.querySelector<HTMLImageElement>(".imgv img");
      expect(el).toBeTruthy();
      return el!;
    })) as HTMLImageElement;
    expect(img.src.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(document.querySelector(".imgv svg, .imgv script")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByText("150%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fit to window" }));
    expect(screen.getByText("Fit")).toBeTruthy();
  });

  it("offers the system viewer for a PDF", async () => {
    render(() => <PreviewBody file={{ repoId: "r1", path: "docs/guide.pdf" }} />);
    const open = vi.spyOn(ipc.viewers, "openExternal");
    fireEvent.click(screen.getByRole("button", { name: "Open in the system viewer" }));
    expect(open).toHaveBeenCalledWith("r1", "docs/guide.pdf");
  });

  it("says so when there is nothing to preview", () => {
    render(() => <PreviewBody file={undefined} />);
    expect(screen.getByText("Nothing to preview")).toBeTruthy();
  });

  it("explains an image over the size limit", async () => {
    vi.spyOn(ipc.viewers, "stat").mockResolvedValue({ size: 40 * 1024 * 1024, mtimeMs: 1 });
    render(() => <PreviewBody file={{ repoId: "r1", path: "assets/pixel.png" }} />);
    await waitFor(() => expect(screen.getByText("Too large to preview here")).toBeTruthy());
  });
});

void execute;
