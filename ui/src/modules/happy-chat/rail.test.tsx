import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRail } from "../../platform/rail";
import { Rail } from "../../shell/Rail";
import type { ChatSummary } from "../../ipc/happy";

const [live, setLive] = createSignal(true);
const [summary, setSummary] = createSignal<Partial<ChatSummary> | undefined>();
const [shown, setShown] = createSignal(false);
const toggleChat = vi.fn();
const showChat = vi.fn();

vi.mock("./state", () => ({
  chatLive: () => live(),
  chatItemVisible: () => live(),
  chatSummary: () => summary(),
  chatTabShown: () => shown(),
  toggleChat: () => toggleChat(),
  showChat: () => showChat(),
  focusChatSearch: () => {},
}));

import { register } from "./index";

beforeEach(() => {
  setLive(true);
  setSummary({ unreadTotal: 0, mentionTotal: 0, threadUnread: 0 });
  setShown(false);
  toggleChat.mockClear();
  showChat.mockClear();
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

  it("hands the click to the chat's own toggle, which knows whether the dock or the Agent panel is showing", () => {
    render(() => <Rail />);
    fireEvent.click(screen.getByRole("button", { name: /Team chat/ }));
    expect(toggleChat).toHaveBeenCalledTimes(1);
    setShown(true);
    fireEvent.click(screen.getByRole("button", { name: /Team chat/ }));
    expect(toggleChat).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: /Team chat/ }).getAttribute("aria-pressed")).toBe("true");
  });
});
