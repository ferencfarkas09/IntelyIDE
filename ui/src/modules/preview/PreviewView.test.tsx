import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import { seedPreviewFixture } from "../../ipc/mock/preview";
import { FRAME_SANDBOX } from "./logic";
import { PreviewView } from "./PreviewView";
import { flushRepoState, resetPreviewState } from "./state";

const frame = () => document.querySelector<HTMLIFrameElement>("iframe.pv__frame");
const urlField = () => screen.getByLabelText("Preview address (loopback only)") as HTMLInputElement;

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  resetPreviewState();
  await ipc.settings.set("preview", { "repo:r": null, defaultDevice: null });
  await seedPreviewFixture(ipc.files, "r", "admin");
  vi.spyOn(ipc.preview, "probe").mockImplementation(async (u) => ({ reachable: true, port: Number(new URL(u).port || 80), ms: 1 }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("<PreviewView> (tab mode)", () => {
  it("starts on the repo kind's default port and lists login pages first, then list pages", async () => {
    render(() => <PreviewView repoId="r" mode="tab" />);
    await waitFor(() => expect(urlField().value).toBe("http://localhost:8082/"));
    await waitFor(() => expect(document.querySelectorAll(".pv-pages__group h4").length).toBeGreaterThanOrEqual(2));
    const headings = [...document.querySelectorAll(".pv-pages__group h4")].map((h) => h.textContent?.trim());
    expect(headings.slice(0, 2)).toEqual(["Login", "List pages"]);
    expect(screen.getByText("Leads Management")).toBeTruthy();
    // dynamic routes sit in the collapsed group and cannot be opened without an id
    expect(screen.queryByText("Lead")).toBeNull();
  });

  it("opens a page from the list in the frame and keeps the frame on loopback with the pinned sandbox", async () => {
    render(() => <PreviewView repoId="r" mode="tab" />);
    await waitFor(() => expect(screen.getByText("Leads Management")).toBeTruthy());
    fireEvent.click(screen.getByText("Leads Management"));
    await waitFor(() => expect(urlField().value).toBe("http://localhost:8082/crm/leads"));
    await waitFor(() => expect(frame()?.getAttribute("src")).toBe("http://localhost:8082/crm/leads"));
    expect(frame()?.getAttribute("sandbox")).toBe(FRAME_SANDBOX);
    expect(frame()?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame()?.getAttribute("allow")).toBe("");
  });

  it("loads the page through the click-to-source proxy and marks the frame for it", async () => {
    const start = vi.spyOn(ipc.preview, "proxyStart").mockResolvedValue({ url: "http://127.0.0.1:51234/", port: 51234, upstreamPort: 8082 });
    render(() => <PreviewView repoId="r" mode="tab" />);
    await waitFor(() => expect(frame()?.getAttribute("src")).toBe("http://127.0.0.1:51234/"));
    expect(start).toHaveBeenCalledWith("http://localhost:8082/");
    expect(frame()?.hasAttribute("data-intely-preview")).toBe(true);
    expect(frame()?.getAttribute("data-repo-id")).toBe("r");
    fireEvent.click(await screen.findByText("Leads Management"));
    await waitFor(() => expect(frame()?.getAttribute("src")).toBe("http://127.0.0.1:51234/crm/leads"));
    // the bar still shows the real dev-server address
    expect(urlField().value).toBe("http://localhost:8082/crm/leads");
  });

  it("falls back to the plain address when no proxy can start", async () => {
    vi.spyOn(ipc.preview, "proxyStart").mockRejectedValue({ code: "proxy", message: "no" });
    render(() => <PreviewView repoId="r" mode="tab" />);
    await waitFor(() => expect(frame()?.getAttribute("src")).toBe("http://localhost:8082/"));
  });

  it("refuses a remote or rebinding address, shows why, and leaves the frame alone", async () => {
    render(() => <PreviewView repoId="r" mode="tab" />);
    await waitFor(() => expect(frame()).toBeTruthy());
    const before = frame()!.getAttribute("src");
    for (const bad of ["https://example.com", "http://127.0.0.1.nip.io:8082/", "http://localhost:8082@evil.com/", "file:///etc/passwd"]) {
      fireEvent.input(urlField(), { target: { value: bad } });
      fireEvent.submit(urlField().closest("form")!);
      await waitFor(() => expect(screen.getByTestId("preview-error")).toBeTruthy());
      expect(frame()!.getAttribute("src")).toBe(before);
    }
    expect(screen.getByTestId("preview-error").textContent ?? "").toMatch(/localhost|credentials|http/i);
  });

  it("shows the production warning in red and remembers environment and device per repo", async () => {
    render(() => <PreviewView repoId="r" mode="tab" />);
    await waitFor(() => expect(screen.getByLabelText("Environment")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(screen.getByLabelText("Environment"), { target: { value: "production" } });
    await waitFor(() => expect(screen.getByText(/Production API\./)).toBeTruthy());
    expect(document.querySelector(".pv")?.getAttribute("data-env")).toBe("production");
    fireEvent.change(screen.getByLabelText("Device"), { target: { value: "iphone-15" } });
    await waitFor(() => expect(frame()?.style.width).toBe("393px"));
    expect(frame()?.style.height).toBe("852px");
    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
    await waitFor(() => expect(frame()?.style.width).toBe("852px"));
    await flushRepoState();
    const stored = (await ipc.settings.get("preview"))["repo:r"] as Record<string, unknown>;
    expect(stored).toMatchObject({ env: "production", device: "iphone-15", rotated: true });

    cleanup();
    resetPreviewState();
    render(() => <PreviewView repoId="r" mode="tab" />);
    await waitFor(() => expect((screen.getByLabelText("Environment") as HTMLSelectElement).value).toBe("production"));
    expect((screen.getByLabelText("Device") as HTMLSelectElement).value).toBe("iphone-15");
  });

  it("tells the user to start the server themselves when nothing is listening, and loads the frame once it answers", async () => {
    const probe = vi.spyOn(ipc.preview, "probe").mockResolvedValue({ reachable: false, port: 8082, ms: 1 });
    render(() => <PreviewView repoId="r" mode="tab" />);
    await waitFor(() => expect(screen.getByText(/Nothing is listening on localhost:8082/)).toBeTruthy());
    expect(screen.getByText(/never starts servers/)).toBeTruthy();
    expect(frame()).toBeNull();
    probe.mockResolvedValue({ reachable: true, port: 8082, ms: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(frame()).toBeTruthy());
  });

  it("opens the system browser only through the validated command", async () => {
    const open = vi.spyOn(ipc.preview, "openExternal").mockResolvedValue();
    render(() => <PreviewView repoId="r" mode="tab" />);
    await waitFor(() => expect(frame()).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Open in browser" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("http://localhost:8082/"));
  });
});
