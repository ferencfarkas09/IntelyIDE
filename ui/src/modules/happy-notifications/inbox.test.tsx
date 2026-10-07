import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import { availableCommands, resetCommands } from "../../platform/commands";
import { dockTabs } from "../../platform/dock";
import { resetOverlays } from "../../platform/overlay";
import { resetStatusItems, statusItems } from "../../platform/statusbar";
import { inboxView } from "../../store/happyNt";
import { connectNtForTest, disconnectNtForTest, ntSim } from "../../store/happyNtTestKit";
import { toast } from "../../ui-kit";
import { chatBadgeCount } from "../happy-chat/ChatItem";
import { chatLive, openChatAt } from "../happy-chat/state";
import Gate from "./Gate";
import { register } from "./index";
import InboxItem from "./InboxItem";
import InboxTab from "./InboxTab";

vi.mock("../happy-chat/state", async (orig) => ({ ...(await orig<typeof import("../happy-chat/state")>()), openChatAt: vi.fn(), chatLive: vi.fn(() => false) }));

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(async () => {
  cleanup();
  vi.mocked(openChatAt).mockClear();
  vi.mocked(chatLive).mockReturnValue(false);
  resetCommands();
  resetStatusItems();
  resetOverlays();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await disconnectNtForTest();
});

describe("happy-notifications register()", () => {
  it("registers an Inbox tab, a status item and commands that stay hidden until the provider is connected", async () => {
    register();
    expect(dockTabs().some((t) => t.id === "inbox")).toBe(true);
    expect(statusItems("right").map((i) => i.id)).not.toContain("happy-inbox");
    expect(availableCommands().map((c) => c.id)).not.toContain("inbox.show");
    const stop = await connectNtForTest();
    expect(statusItems("right").map((i) => i.id)).toContain("happy-inbox");
    expect(availableCommands().map((c) => c.id)).toEqual(expect.arrayContaining(["inbox.show", "inbox.markAllRead"]));
    stop();
  });

  it("hides the status item when 'Show in the status bar' is off", async () => {
    register();
    const stop = await connectNtForTest({ notifications: { showInStatusBar: false } });
    expect(statusItems("right").map((i) => i.id)).not.toContain("happy-inbox");
    stop();
  });

  it("costs nothing while off: no feed, no view, no read of the inbox", async () => {
    const current = vi.spyOn(ipc.happy.notifications, "current");
    const list = vi.spyOn(ipc.happy.notifications, "list");
    register();
    await flush();
    expect(current).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(inboxView().loaded).toBe(false);
  });
});

describe("<InboxTab>", () => {
  it("explains that Notifications is off", () => {
    render(() => <InboxTab />);
    expect(screen.getByText("Notifications are off")).toBeTruthy();
  });

  it("lists the notifications, unread first by time, with the unread count", async () => {
    const stop = await connectNtForTest();
    render(() => <InboxTab />);
    expect(await screen.findByText("Anna mentioned you in #dev")).toBeTruthy();
    expect(screen.getByText("Deploy finished: sandbox")).toBeTruthy();
    expect(screen.getByTitle("Unread").textContent).toBe("4");
    stop();
  });

  it("marks one notification and then everything as read", async () => {
    const stop = await connectNtForTest();
    const markRead = vi.spyOn(ipc.happy.notifications, "markRead");
    render(() => <InboxTab />);
    fireEvent.click(await screen.findByRole("button", { name: 'Mark "Anna mentioned you in #dev" as read' }));
    await waitFor(() => expect(markRead).toHaveBeenCalledWith("n_1"));
    await waitFor(() => expect(screen.getByTitle("Unread").textContent).toBe("3"));
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(inboxView().unread).toBe(0));
    expect(screen.queryByTitle("Unread")).toBeNull();
    stop();
  });

  it("shows a toast and keeps the row when marking as read fails", async () => {
    const stop = await connectNtForTest();
    vi.spyOn(ipc.happy.notifications, "markRead").mockRejectedValue({ code: "notFound", message: "No such notification" });
    const show = vi.spyOn(toast, "show");
    render(() => <InboxTab />);
    fireEvent.click(await screen.findByRole("button", { name: 'Mark "Anna mentioned you in #dev" as read' }));
    await waitFor(() => expect(show).toHaveBeenCalledWith(expect.objectContaining({ title: "Could not mark it as read", tone: "danger" })));
    expect(inboxView().unread).toBe(4);
    stop();
  });

  it("disables marking when actions are off, and says why", async () => {
    const stop = await connectNtForTest({ notifications: { allowActions: false } });
    render(() => <InboxTab />);
    expect(await screen.findByText("Anna mentioned you in #dev")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Mark all read" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /^Mark ".*" as read$/ })).toBeNull();
    expect(screen.getByText(/Marking as read is off/)).toBeTruthy();
    stop();
  });

  it("keeps the cached list and marks it out of date when a refresh fails", async () => {
    const stop = await connectNtForTest();
    vi.spyOn(ipc.happy.notifications, "list").mockRejectedValueOnce({ code: "offline", message: "Could not reach Happy" });
    render(() => <InboxTab />);
    // The list that was cached stays on screen, marked out of date.
    expect(await screen.findByText(/Out of date/)).toBeTruthy();
    expect(screen.getByText("Anna mentioned you in #dev")).toBeTruthy();
    stop();
  });
});

describe("chat notifications", () => {
  it("shows the actor, preview and a day group, and opens the chat at the message", async () => {
    const stop = await connectNtForTest();
    const markRead = vi.spyOn(ipc.happy.notifications, "markRead");
    render(() => <InboxTab />);
    expect(await screen.findByText("Can you send me the receipt export?")).toBeTruthy();
    expect(screen.getAllByText("Today").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("Kovács Anna"));
    expect(openChatAt).toHaveBeenCalledWith({ channelId: "d_anna", messageId: "m_d_anna_10", threadRootId: undefined });
    await waitFor(() => expect(markRead).toHaveBeenCalledWith("n_c1"));
    stop();
  });

  it("opens a thread reply with its root, and a plain notification only marks it read", async () => {
    const stop = await connectNtForTest();
    const markRead = vi.spyOn(ipc.happy.notifications, "markRead");
    render(() => <InboxTab />);
    fireEvent.click(await screen.findByText("Szabó Réka replied in #dev"));
    expect(openChatAt).toHaveBeenCalledWith({ channelId: "c_dev", messageId: "m_c_dev_45", threadRootId: "m_c_dev_40" });
    fireEvent.click(screen.getByText("Task assigned: Receipts"));
    await waitFor(() => expect(markRead).toHaveBeenCalledWith("n_2"));
    expect(openChatAt).toHaveBeenCalledTimes(1);
    stop();
  });

  it("marks one as unread again and deletes one", async () => {
    const stop = await connectNtForTest();
    render(() => <InboxTab />);
    fireEvent.click(await screen.findByRole("button", { name: 'Mark "Deploy finished: sandbox" as unread' }));
    await waitFor(() => expect(inboxView().unread).toBe(5));
    fireEvent.click(screen.getByRole("button", { name: 'Delete "Deploy finished: sandbox"' }));
    await waitFor(() => expect(inboxView().items.some((i) => i.id === "n_3")).toBe(false));
    expect(inboxView().unread).toBe(4);
    stop();
  });

  it("moves between rows with the arrow keys", async () => {
    const stop = await connectNtForTest();
    render(() => <InboxTab />);
    const first = (await screen.findByText("Kovács Anna")).closest("button")!;
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toContain("Anna mentioned you in #dev");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
    stop();
  });
});

describe("badges", () => {
  it("counts unread messages plus threads with unseen replies", () => {
    expect(chatBadgeCount({ unreadTotal: 3, threadUnread: 1 })).toBe(4);
    expect(chatBadgeCount({ unreadTotal: 2 })).toBe(2);
    expect(chatBadgeCount(undefined)).toBe(0);
  });

  it("a pushed notification is in the inbox at once and raises the count", async () => {
    const stop = await connectNtForTest();
    ntSim().push({ title: "Pushed", kind: "deploy" });
    await waitFor(() => expect(inboxView().unread).toBe(5));
    expect(inboxView().items.some((i) => i.title === "Pushed")).toBe(true);
    stop();
  });
});

describe("<InboxItem>", () => {
  it("shows the unread count and follows new arrivals", async () => {
    const stop = await connectNtForTest();
    render(() => <InboxItem />);
    expect(screen.getByRole("button", { name: "4 unread notifications" })).toBeTruthy();
    ntSim().notify("Standup moved", "meeting");
    await waitFor(() => expect(screen.getByRole("button", { name: "5 unread notifications" })).toBeTruthy());
    stop();
  });
});

describe("toasts (transitions only)", () => {
  it("stays quiet for the backlog, announces one arrival, and folds a burst into one toast", async () => {
    const stop = await connectNtForTest();
    const show = vi.spyOn(toast, "show");
    render(() => <Gate />);
    await vi.dynamicImportSettled();
    await flush();
    expect(show).not.toHaveBeenCalled();
    ntSim().notify("Deploy failed: sandbox", "deploy");
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    expect(show.mock.calls[0][0]).toMatchObject({ title: "Deploy failed: sandbox", tone: "info", action: { label: "Open inbox" } });
    // Two more inside the gap are held back and announced together later.
    vi.useFakeTimers();
    ntSim().notify("One");
    ntSim().notify("Two");
    expect(show).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_500);
    expect(show).toHaveBeenCalledTimes(2);
    expect(show.mock.calls[1][0]).toMatchObject({ title: "2 new notifications" });
    stop();
  });

  const pushChat = () => ntSim().push({ title: "Nagy Péter", body: "hi", kind: "chat", eventKey: "chat.message.direct", channelId: "d_peter", messageId: "m_d_peter_7" });

  it("toasts a pushed chat item once when chat is not live, and the action opens it in the chat", async () => {
    const stop = await connectNtForTest();
    const show = vi.spyOn(toast, "show");
    render(() => <Gate />);
    await vi.dynamicImportSettled();
    await flush();
    pushChat();
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    await flush();
    expect(show).toHaveBeenCalledTimes(1);
    show.mock.calls[0][0].action!.onSelect();
    expect(openChatAt).toHaveBeenCalledWith({ channelId: "d_peter", messageId: "m_d_peter_7", threadRootId: undefined });
    stop();
  });

  it("never double-toasts a chat item while chat is live", async () => {
    vi.mocked(chatLive).mockReturnValue(true);
    const stop = await connectNtForTest();
    const show = vi.spyOn(toast, "show");
    render(() => <Gate />);
    await vi.dynamicImportSettled();
    await flush();
    pushChat();
    await flush();
    expect(show).not.toHaveBeenCalled();
    ntSim().notify("Deploy failed", "deploy");
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    stop();
  });

  it("renders nothing and loads nothing while Notifications is off", async () => {
    const show = vi.spyOn(toast, "show");
    render(() => <Gate />);
    await flush();
    expect(show).not.toHaveBeenCalled();
    expect(document.body.textContent).toBe("");
  });
});
