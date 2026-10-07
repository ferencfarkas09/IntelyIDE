import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRail } from "../../platform/rail";
import { Rail } from "../../shell/Rail";
import type { ChatSummary } from "../../ipc/happy";

const [live, setLive] = createSignal(true);
const [summary, setSummary] = createSignal<Partial<ChatSummary> | undefined>();
const [shown, setShown] = createSignal(false);
const openChat = vi.fn();
const toggleDockTab = vi.fn();

vi.mock("./state", () => ({
  chatLive: () => live(),
  chatItemVisible: () => live(),
  chatSummary: () => summary(),
  chatTabShown: () => shown(),
  openChat: (...a: unknown[]) => openChat(...a),
  focusChatSearch: () => {},
}));
vi.mock("../../platform/dock", async (orig) => ({ ...(await orig<typeof import("../../platform/dock")>()), toggleDockTab: (id: string) => toggleDockTab(id) }));

import { register } from "./index";

beforeEach(() => {
  setLive(true);
  setSummary({ unreadTotal: 0, mentionTotal: 0, threadUnread: 0 });
  setShown(false);
  openChat.mockClear();
  toggleDockTab.mockClear();
  register();
});
afterEach(() => {
  cleanup();
  resetRail();
});

describe("Team chat rail item", () => {
  it("is hidden while the provider is off or signed out", () => {
    setLive(false);
    render(() => <Rail />);
    expect(screen.queryByRole("button", { name: /Team chat/ })).toBeNull();
    setLive(true);
    expect(screen.getByRole("button", { name: /Team chat/ })).toBeTruthy();
  });

  it("shows no badge at zero, the count, and 99+ above 99", () => {
    const { container } = render(() => <Rail />);
    const badge = () => container.querySelector(".rail__badge");
    expect(badge()).toBeNull();
    setSummary({ unreadTotal: 5, mentionTotal: 0, threadUnread: 0 });
    expect(badge()?.textContent).toBe("5");
    expect(badge()?.getAttribute("data-tone")).toBeNull();
    expect(screen.getByRole("button", { name: "Team chat, 5 unread" })).toBeTruthy();
    setSummary({ unreadTotal: 120, mentionTotal: 0, threadUnread: 0 });
    expect(badge()?.textContent).toBe("99+");
  });

  it("turns the badge urgent while someone mentioned you", () => {
    setSummary({ unreadTotal: 2, mentionTotal: 1, threadUnread: 1 });
    const { container } = render(() => <Rail />);
    const badge = container.querySelector(".rail__badge");
    expect(badge?.textContent).toBe("3");
    expect(badge?.getAttribute("data-tone")).toBe("urgent");
    expect(screen.getByRole("button", { name: "Team chat, 3 unread, 1 mention" })).toBeTruthy();
  });

  it("opens the chat dock tab, and hides the dock when it is already showing", () => {
    render(() => <Rail />);
    fireEvent.click(screen.getByRole("button", { name: /Team chat/ }));
    expect(openChat).toHaveBeenCalledTimes(1);
    setShown(true);
    fireEvent.click(screen.getByRole("button", { name: /Team chat/ }));
    expect(toggleDockTab).toHaveBeenCalledWith("chat");
  });
});
