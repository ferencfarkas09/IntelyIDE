import { cleanup, configure, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async (orig) => {
  const mod = await orig<typeof import("../../ipc")>();
  const { createMockIpc } = await import("../../ipc/mock");
  return { ...mod, ipc: createMockIpc("normal", { delayScale: 0 }) };
});

import { ipc } from "../../ipc";
import type { ProviderInfo } from "../../ipc/providers";
import { installDomStubs } from "../../store/testing-u2";
import { ProviderCard } from "./ProviderCard";
import ProvidersSection from "./ProvidersSection";

configure({ asyncUtilTimeout: 15000 });
vi.setConfig({ testTimeout: 30000 });
installDomStubs();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const claudeWith = async (message: string | null): Promise<ProviderInfo> => ({ ...(await ipc.providers.detect()).find((p) => p.id === "claude")!, message });

function mount(provider: ProviderInfo, onChange: (p: ProviderInfo) => void = () => {}) {
  return render(() => <ProviderCard provider={provider} baseUrl="" enforcement={[]} experimentalOn={false} onChange={onChange} onRefresh={async () => {}} />);
}

describe("<SdkCard> in the Claude card", () => {
  it.each([
    ["sdk_missing: no Agent SDK under ~/Library/x", "Claude Agent SDK is not installed", "SDK missing"],
    ["sdk_incompatible: found 0.3.1, need 0.3.287", "Claude Agent SDK has the wrong version", "SDK version"],
    ["sdk_unverified: a file differs from the checksum list", "Claude Agent SDK does not match the pinned files", "SDK unverified"],
    ["sdk_broken: dependency zod", "Claude Agent SDK is incomplete", "SDK broken"],
  ])("%s", async (message, title, chip) => {
    mount(await claudeWith(message));
    const card = await screen.findByRole("group", { name: title });
    expect(within(card).getByText(message.split(": ")[1])).toBeTruthy();
    expect(screen.getByText(chip)).toBeTruthy();
    // the CLI exists: never claimed as missing
    expect(screen.queryByText("Not installed")).toBeNull();
    expect(within(card).getByLabelText("Commands that install the pinned Agent SDK").textContent).toContain("npm ci --ignore-scripts --omit=optional --prefix");
    expect(within(card).getByText(/Anthropic software under Anthropic's terms/)).toBeTruthy();
    expect(within(card).getByText(/mode 0700/)).toBeTruthy();
  });

  it("no card and the normal chip when the SDK is fine", async () => {
    mount(await claudeWith(null));
    await screen.findByRole("article", { name: "Claude" });
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.getByText("Ready")).toBeTruthy();
  });

  it("Copy puts the commands on the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mount(await claudeWith("sdk_missing: x"));
    fireEvent.click(await screen.findByRole("button", { name: "Copy commands" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0][0]).toContain("mkdir -m 700");
  });

  it("Check again calls detect again and shows the card go away once the SDK is there", async () => {
    const onChange = vi.fn();
    const start = await claudeWith("sdk_missing: x");
    const detect = vi.spyOn(ipc.providers, "detect");
    mount(start, onChange);
    fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
    await waitFor(() => expect(detect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0][0].id).toBe("claude");
    // the mock detects a healthy SDK
    expect(await screen.findByText("Checked again: the Agent SDK works.")).toBeTruthy();
  });

  it("Check again keeps the card and says so while the SDK is still unusable", async () => {
    const still = await claudeWith("sdk_missing: x");
    vi.spyOn(ipc.providers, "detect").mockResolvedValue([still]);
    mount(still);
    fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
    expect(await screen.findByText("Checked again: it is still not usable.")).toBeTruthy();
  });

  it("the Settings section shows the card from a live detection", async () => {
    const withSdk = await claudeWith("sdk_unverified: tampered");
    vi.spyOn(ipc.providers, "list").mockResolvedValue([withSdk]);
    vi.spyOn(ipc.providers, "detect").mockResolvedValue([withSdk]);
    render(() => <ProvidersSection />);
    expect(await screen.findByRole("group", { name: "Claude Agent SDK does not match the pinned files" })).toBeTruthy();
  });
});
