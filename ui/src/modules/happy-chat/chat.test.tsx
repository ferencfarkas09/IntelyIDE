import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import type { MockChatSim } from "../../ipc/mock/happy";
import { createMockHappy, type ChatScenario } from "../../ipc/mock/happy";
import { availableCommands, resetCommands } from "../../platform/commands";
import { registerChatComposerExtension, resetChatComposerExtensions } from "../../platform/chatComposer";
import { activeDockTab, dockTabs, setDockOpen } from "../../platform/dock";
import { resetOverlays } from "../../platform/overlay";
import { resetStatusItems, statusItems } from "../../platform/statusbar";
import { startHappyWatch } from "../../store/happy";
import { installDomStubs } from "../../store/testing-u2";
import { toast } from "../../ui-kit";
import ChatItem from "./ChatItem";
import ChatWatcher from "./ChatWatcher";
import ChatTab from "./ChatTab";
import { register } from "./index";
import { chatDialog, closeChatDialog } from "./dialogs";
import { MessageRow } from "./Message";
import { jumpToMessage, resetChat, setActiveChannel, setChatMainView, setChatScreen, startChat, threadOf, threadPanel } from "./state";
import type { ChatMessage } from "../../ipc/happy";

installDomStubs();

// jsdom has no layout; the virtual list sizes itself from offsetWidth/offsetHeight and renders nothing for 0.
const sizes = ["offsetWidth", "offsetHeight"] as const;
const saved = sizes.map((k) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, k));
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 360 });
  // The scroller is huge so every row counts as visible; a row measures 40 px.
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("ui-scroll__viewport") ? 100_000 : 40;
    },
  });
});
afterAll(() => {
  sizes.forEach((k, i) => (saved[i] ? Object.defineProperty(HTMLElement.prototype, k, saved[i]!) : delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k]));
});

type Mock = ReturnType<typeof createMockHappy>;
const original = ipc.happy;
const flush = () => new Promise((r) => setTimeout(r, 0));
let stops: (() => void)[] = [];
let happy: Mock;
let sim: MockChatSim;

/** Replaces the IPC with a fresh mock in `scenario`, starts the Happy watcher and, unless told not to, the chat state. */
async function bring(scenario: ChatScenario = "ok", opts: { chat?: boolean; preset?: "off" | "connected" } = {}) {
  happy = createMockHappy({ preset: opts.preset ?? "connected", chat: scenario });
  sim = happy.chatSim;
  (ipc as { happy: unknown }).happy = happy;
  const status = await happy.status();
  vi.spyOn(ipc.settings, "get").mockResolvedValue(status.config);
  stops.push(startHappyWatch());
  await flush();
  await flush();
  if (opts.chat !== false) stops.push(startChat());
  await flush();
  await flush();
}

/** jsdom has no layout: the tab measures itself with clientWidth, which a test sets to pick the layout (0 = the single column). */
let tabWidth = 0;
const savedWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth");
beforeAll(() => {
  Object.defineProperty(Element.prototype, "clientWidth", {
    configurable: true,
    get(this: Element) {
      return this.classList.contains("hc") ? tabWidth : 0;
    },
  });
});
afterAll(() => {
  if (savedWidth) Object.defineProperty(Element.prototype, "clientWidth", savedWidth);
});

beforeEach(() => {
  tabWidth = 0;
  setChatMainView("channel");
  closeChatDialog();
  setChatScreen("list");
  setActiveChannel(undefined);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  stops.forEach((s) => s());
  stops = [];
  resetChat();
  resetCommands();
  resetStatusItems();
  resetOverlays();
  resetChatComposerExtensions();
  toast.clear();
  setDockOpen(false);
  (ipc as { happy: unknown }).happy = original;
  vi.restoreAllMocks();
});

const openRow = async (name: RegExp | string) => {
  const row = await screen.findByRole("option", { name });
  fireEvent.click(row);
  return screen.findByTestId("chat-conversation");
};
const composer = () => screen.getByRole("textbox", { name: /^Message / }) as HTMLTextAreaElement;
const type = (text: string) => fireEvent.input(composer(), { target: { value: text } });
const enter = (shift = false) => fireEvent.keyDown(composer(), { key: "Enter", shiftKey: shift });

describe("register()", () => {
  it("adds the Chat tab, a status bubble and commands that stay hidden until chat is up", async () => {
    register();
    expect(dockTabs().some((t) => t.id === "chat" && t.title === "Chat")).toBe(true);
    expect(statusItems("right").map((i) => i.id)).not.toContain("happy-chat");
    expect(availableCommands().map((c) => c.id)).not.toContain("chat.show");
    await bring();
    expect(statusItems("right").map((i) => i.id)).toContain("happy-chat");
    expect(availableCommands().map((c) => c.id)).toEqual(expect.arrayContaining(["chat.show", "chat.goto"]));
  });

  it("costs nothing while chat is off: no subscription and no request; it starts when chat comes up", async () => {
    register();
    await bring("ok", { chat: false, preset: "off" });
    const onEvent = vi.spyOn(ipc.happy.chat, "onEvent");
    const summary = vi.spyOn(ipc.happy.chat, "summary");
    render(() => <ChatWatcher />);
    await flush();
    expect(statusItems("right").map((i) => i.id)).not.toContain("happy-chat");
    expect(onEvent).not.toHaveBeenCalled();
    expect(summary).not.toHaveBeenCalled();
    cleanup();
    stops.forEach((s) => s());
    stops = [];
    await bring("ok", { chat: false });
    const live = vi.spyOn(ipc.happy.chat, "onEvent");
    render(() => <ChatWatcher />);
    await flush();
    expect(live).toHaveBeenCalledTimes(1);
  });
});

describe("<ChatTab> states", () => {
  it("explains that chat is off", async () => {
    await bring("ok", { chat: false, preset: "off" });
    render(() => <ChatTab />);
    expect(screen.getByText("Team chat is off")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open settings" })).toBeTruthy();
  });

  it("shows the 401 state as an alert that asks for a new token", async () => {
    await bring("signedout", { chat: false });
    render(() => <ChatTab />);
    expect(screen.getByRole("alert").textContent).toContain("Your Happy session ended");
  });

  it("shows the 403 state with the reason", async () => {
    await bring("forbidden", { chat: false });
    render(() => <ChatTab />);
    expect(screen.getByText("Team chat is not available for this account")).toBeTruthy();
    expect(screen.getByText(/chat\.page\.access/)).toBeTruthy();
  });

  it("says when a token is still missing", async () => {
    happy = createMockHappy({ preset: "off" });
    (ipc as { happy: unknown }).happy = happy;
    await happy.setConfig({ master: true, chat: { enabled: true } });
    vi.spyOn(ipc.settings, "get").mockResolvedValue((await happy.status()).config);
    stops.push(startHappyWatch());
    await flush();
    await flush();
    render(() => <ChatTab />);
    expect(screen.getByText("Add a Happy token")).toBeTruthy();
  });

  it("shows an empty state with the people search when there are no conversations", async () => {
    await bring("empty");
    render(() => <ChatTab />);
    expect(await screen.findByText("No conversations yet")).toBeTruthy();
  });

  it("marks stale data when the connection is down", async () => {
    await bring("offline");
    render(() => <ChatTab />);
    expect(await screen.findByText(/Offline\. Showing the last data/)).toBeTruthy();
    await openRow(/^#general/);
    expect(screen.getByText(/Offline\. These are the last messages/)).toBeTruthy();
  });
});

describe("conversation list", () => {
  it("lists Unread, Channels and Direct with unread badges, mentions and muted channels", async () => {
    await bring();
    render(() => <ChatTab />);
    const nav = await screen.findByRole("navigation", { name: "Chat navigation" });
    expect(within(nav).getAllByRole("listbox").map((g) => g.getAttribute("aria-label"))).toEqual(["Unread", "Channels", "Direct"]);
    expect(screen.getByRole("option", { name: "#general, 3 unread, 1 mention" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "#random, 5 unread, muted" }).getAttribute("data-muted")).toBe("");
    expect(screen.getByRole("option", { name: "Kovács Anna, 1 unread" })).toBeTruthy();
  });

  it("filters by name without caring about accents, and offers people for a new direct message", async () => {
    await bring();
    render(() => <ChatTab />);
    const search = await screen.findByRole("textbox", { name: "Search conversations and people" });
    fireEvent.input(search, { target: { value: "kovacs" } });
    expect(screen.queryByRole("option", { name: /#general/ })).toBeNull();
    expect(screen.getByRole("option", { name: "Kovács Anna, 1 unread" })).toBeTruthy();
    fireEvent.input(search, { target: { value: "réka" } });
    const person = await screen.findByRole("option", { name: /Szabó Réka/ });
    fireEvent.click(person);
    expect(await screen.findByRole("heading", { name: "Szabó Réka" })).toBeTruthy();
  });

  it("moves with the arrow keys and opens with Enter or a click", async () => {
    await bring();
    render(() => <ChatTab />);
    const search = await screen.findByRole("textbox", { name: "Search conversations and people" });
    search.focus();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    // The Threads entry comes first, then the conversations.
    const threads = screen.getByRole("button", { name: /^Threads/ });
    expect(document.activeElement).toBe(threads);
    const rows = screen.getAllByRole("option");
    fireEvent.keyDown(threads, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(rows[0]!, { key: "End" });
    expect(document.activeElement).toBe([...document.querySelectorAll(".hc-row")].at(-1));
    fireEvent.keyDown(threads, { key: "ArrowUp" });
    expect(document.activeElement).toBe(search);
  });
});

describe("conversation", () => {
  it("shows messages in plain text with day separators, the new-messages divider, links and mentions", async () => {
    await bring();
    render(() => <ChatTab />);
    const conv = await openRow(/^#general/);
    await within(conv).findAllByText(/Jó reggelt mindenkinek/);
    expect(within(conv).getAllByRole("separator").some((s) => s.textContent === "New messages")).toBe(true);
    const link = within(conv).getAllByRole("link", { name: /github\.com\/happy\/pos\/pull\/482/ })[0] as HTMLAnchorElement;
    expect(link.href).toBe("https://github.com/happy/pos/pull/482");
    // An http link is shown but cannot be opened.
    expect(within(conv).queryByRole("link", { name: /old\.example\.test/ })).toBeNull();
    expect(conv.querySelector(".hc-link--inert")?.textContent).toContain("http://old.example.test/status");
    const mention = conv.querySelector(".hc-mention[data-me]");
    expect(mention?.textContent).toBe("@Teszt Elek");
    expect(conv.querySelector("[data-mention]")).toBeTruthy();
  });

  it("opens a link through Rust, never in the webview", async () => {
    await bring();
    render(() => <ChatTab />);
    const conv = await openRow(/^#general/);
    const open = vi.spyOn(ipc.happy, "openExternal");
    const link = (await within(conv).findAllByRole("link", { name: /github\.com/ }))[0]!;
    expect(fireEvent.click(link)).toBe(false); // default prevented
    await waitFor(() => expect(open).toHaveBeenCalledWith("https://github.com/happy/pos/pull/482"));
  });

  it("renders markup as text, so a hostile message cannot run anything", async () => {
    await bring();
    render(() => <ChatTab />);
    const conv = await openRow(/^#general/);
    sim.receive("c_general", '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script> https://good.test@evil.test/');
    const text = await within(conv).findByText(/<img src=x/);
    expect(text.querySelector("img, script")).toBeNull();
    expect(text.querySelector("a")).toBeNull();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("marks the conversation read once it is in front", async () => {
    await bring();
    render(() => <ChatTab />);
    await openRow(/^#general/);
    await waitFor(() => expect(sim.readCalls()).toContain("c_general"));
    expect(sim.viewing()).toBe("c_general");
    await waitFor(() => expect(screen.queryByRole("option", { name: /#general, 3 unread/ })).toBeNull());
  });

  it("appends live messages and shows the typing line", async () => {
    await bring();
    render(() => <ChatTab />);
    const conv = await openRow(/^#general/);
    sim.typing("c_general", ["Kovács Anna", "Teszt Elek"]);
    expect(await within(conv).findByText("Kovács is typing…")).toBeTruthy();
    sim.receive("c_general", "Ez élőben érkezett");
    expect(await within(conv).findByText("Ez élőben érkezett")).toBeTruthy();
  });

  it("goes back to the list with Escape from an empty composer and keeps the typed text otherwise", async () => {
    await bring();
    render(() => <ChatTab />);
    await openRow(/^#general/);
    type("draft");
    fireEvent.keyDown(composer(), { key: "Escape" });
    expect(screen.getByTestId("chat-conversation")).toBeTruthy();
    type("");
    fireEvent.keyDown(composer(), { key: "Escape" });
    expect(await screen.findByRole("navigation", { name: "Chat navigation" })).toBeTruthy();
  });

  it("keeps the draft of a conversation when you leave and come back", async () => {
    await bring();
    render(() => <ChatTab />);
    await openRow(/^#general/);
    type("félkész gondolat");
    fireEvent.click(screen.getByRole("button", { name: /^Back to/ }));
    await openRow(/^#general/);
    expect(composer().value).toBe("félkész gondolat");
  });
});

describe("sending", () => {
  it("sends with Enter, shows the message at once and replaces it with the echo exactly once", async () => {
    await bring();
    render(() => <ChatTab />);
    const conv = await openRow(/^#dev/);
    const send = vi.spyOn(ipc.happy.chat, "send");
    type("Szia, ez az új üzenet");
    enter(true);
    expect(send).not.toHaveBeenCalled();
    enter();
    await waitFor(() => expect(composer().value).toBe(""));
    expect(await within(conv).findByText("Szia, ez az új üzenet")).toBeTruthy();
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]!.slice(0, 2)).toEqual(["c_dev", "Szia, ez az új üzenet"]);
    expect(send.mock.calls[0]![2]).toMatch(/\S{8,}/);
    await flush();
    expect(within(conv).getAllByText("Szia, ez az új üzenet")).toHaveLength(1);
    expect(conv.querySelector("[data-state='pending'], [data-state='failed']")).toBeNull();
  });

  it("shows a pending state while the server is slow", async () => {
    await bring();
    sim.setSendDelay(50);
    render(() => <ChatTab />);
    const conv = await openRow(/^#dev/);
    type("lassú");
    enter();
    expect(await within(conv).findByText("Sending…")).toBeTruthy();
    await waitFor(() => expect(within(conv).queryByText("Sending…")).toBeNull());
  });

  it("keeps a failed message visible with Retry and Remove, and retries with the same id", async () => {
    await bring();
    render(() => <ChatTab />);
    const conv = await openRow(/^#dev/);
    const send = vi.spyOn(ipc.happy.chat, "send");
    sim.failNext("offline", "Network down");
    type("újra próbálom");
    enter();
    expect(await within(conv).findByText("Not sent: offline")).toBeTruthy();
    fireEvent.click(within(conv).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(within(conv).queryByText(/Not sent/)).toBeNull());
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![2]).toBe(send.mock.calls[0]![2]);
    expect(within(conv).getAllByText("újra próbálom")).toHaveLength(1);

    sim.failNext("offline");
    type("ezt eldobom");
    enter();
    fireEvent.click(await within(conv).findByRole("button", { name: "Remove" }));
    expect(within(conv).queryByText("ezt eldobom")).toBeNull();
  });

  it("blocks sending with a banner when the store is out of credits, and recovers after Check again", async () => {
    await bring("nocredits");
    render(() => <ChatTab />);
    const conv = await openRow(/^#dev/);
    expect(within(conv).getByText("Out of credits")).toBeTruthy();
    type("nem megy");
    expect(screen.getByRole("button", { name: "Send message" }).getAttribute("aria-disabled")).toBe("true");
    enter();
    expect(within(conv).queryByText("nem megy", { selector: ".hc-msg__text" })).toBeNull();
    const fresh = { ...(await ipc.happy.chat.summary()), creditsEmpty: false, credits: 3 };
    vi.spyOn(ipc.happy.chat, "summary").mockResolvedValue(fresh);
    fireEvent.click(within(conv).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(within(conv).queryByText("Out of credits")).toBeNull());
    expect(screen.getByRole("button", { name: "Send message" }).getAttribute("aria-disabled")).toBeNull();
  });

  it("lifts the blocked state by itself when the balance comes back", async () => {
    await bring("nocredits");
    render(() => <ChatTab />);
    const conv = await openRow(/^#dev/);
    expect(within(conv).getByText("Out of credits")).toBeTruthy();
    sim.setCredits(3);
    await waitFor(() => expect(within(conv).queryByText("Out of credits")).toBeNull());
    type("most már megy");
    enter();
    expect(await within(conv).findByText("most már megy", { selector: ".hc-msg__text" })).toBeTruthy();
  });

  it("turns a 402 answer into the blocked state and a failed message", async () => {
    await bring();
    render(() => <ChatTab />);
    const conv = await openRow(/^#dev/);
    sim.failNext("INSUFFICIENT_CREDITS", "No credits");
    type("utolsó");
    enter();
    expect(await within(conv).findByText("Not sent: no credits left")).toBeTruthy();
    expect(within(conv).getByText("Out of credits")).toBeTruthy();
  });

  it("states the cost of a message and counts long ones", async () => {
    await bring();
    render(() => <ChatTab />);
    const conv = await openRow(/^#dev/);
    expect(within(conv).getByText("Each message costs 0.02 credits · 12.46 left")).toBeTruthy();
    expect(within(conv).queryByText(/\/ 8,000/)).toBeNull();
    type("x".repeat(7100));
    expect(within(conv).getByText("7,100 / 8,000")).toBeTruthy();
    type("x".repeat(8100));
    expect(screen.getByRole("button", { name: "Send message" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("lets other modules add to a message through the composer hook", async () => {
    await bring();
    registerChatComposerExtension({ id: "files", collect: () => ({ attachmentIds: ["a1", "a2"] }), clear: vi.fn() });
    render(() => <ChatTab />);
    await openRow(/^#dev/);
    const send = vi.spyOn(ipc.happy.chat, "send");
    type("fájlokkal");
    enter();
    await waitFor(() => expect(send).toHaveBeenCalledWith("c_dev", "fájlokkal", expect.any(String), { attachmentIds: ["a1", "a2"] }));
  });

  it("stops a send that an extension blocks", async () => {
    await bring();
    registerChatComposerExtension({ id: "guard", collect: () => ({ block: "May contain secrets, confirm first" }) });
    render(() => <ChatTab />);
    await openRow(/^#dev/);
    const send = vi.spyOn(ipc.happy.chat, "send");
    type("titok");
    enter();
    expect(await screen.findByText("May contain secrets, confirm first")).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it("never writes message text to the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    await bring();
    render(() => <ChatTab />);
    await openRow(/^#dev/);
    type("titkos üzenet szövege");
    enter();
    sim.receive("c_dev", "bejövő titkos szöveg");
    await flush();
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toMatch(/titkos/);
  });
});

describe("status bar and toasts", () => {
  it("shows the unread total and the mention dot, and opens the Chat tab", async () => {
    register();
    await bring();
    render(() => <ChatItem />);
    const button = screen.getByRole("button", { name: /Team chat, 18 unread, 1 mention/ });
    expect(button.textContent).toContain("19"); // 18 unread messages + 1 thread with news
    fireEvent.click(button);
    expect(activeDockTab()?.id).toBe("chat");
  });

  it("toasts a mention once and folds a storm into a single later toast", async () => {
    await bring();
    const show = vi.spyOn(toast, "show");
    sim.receive("c_ops", "@Teszt Elek nézd meg a mentést");
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0]![0]).toMatchObject({ title: "Kovács Anna mentioned you in #ops", tone: "warn" });
    for (let i = 0; i < 30; i++) sim.receive("d_anna", `üzenet ${i}`);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("stays quiet for muted channels, plain channel traffic and the conversation in front", async () => {
    await bring();
    const show = vi.spyOn(toast, "show");
    sim.receive("c_random", "@Teszt Elek muted but mentioned");
    sim.receive("c_dev", "plain channel message");
    expect(show).not.toHaveBeenCalled();
    render(() => <ChatTab />);
    await openRow("Kovács Anna, 1 unread");
    sim.receive("d_anna", "direct while looking at it");
    expect(show).not.toHaveBeenCalled();
  });

  it("does not toast signed-out or offline transitions", async () => {
    await bring();
    const show = vi.spyOn(toast, "show");
    sim.setLink("reconnecting");
    sim.setLink("live");
    expect(show).not.toHaveBeenCalled();
  });
});

describe("team chat not enabled", () => {
  it("shows the friendly not-enabled state instead of the generic denied one", async () => {
    await bring("notenabled", { chat: false });
    render(() => <ChatTab />);
    expect(await screen.findByText("Team chat is not enabled for this store yet")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Search conversations and people" })).toBeNull();
  });
});

// ---- Slack-like layout: sidebar, threads, message actions, composer ------------------------------------------------

const msgEl = (root: HTMLElement, id: string) => root.querySelector<HTMLElement>(`[data-msg="${id}"]`)!;
const threadPane = () => screen.findByTestId("chat-thread");
/** The root message of the seeded #dev thread, once the messages are in. */
const devRoot = async (conv: HTMLElement) => {
  await within(conv).findAllByTestId("chat-message");
  return msgEl(conv, "m_c_dev_4");
};

describe("sidebar", () => {
  it("shows Threads with the server's unread count, then Unread, Channels (+ New channel, Browse) and Direct", async () => {
    tabWidth = 1000;
    await bring();
    render(() => <ChatTab />);
    const nav = await screen.findByRole("navigation", { name: "Chat navigation" });
    const threads = within(nav).getByRole("button", { name: "Threads, 1 with new replies" });
    expect(threads.textContent).toContain("1");
    expect(within(nav).getAllByRole("listbox").map((g) => g.getAttribute("aria-label"))).toEqual(["Unread", "Channels", "Direct"]);
    expect(within(nav).getByRole("button", { name: "Browse channels" })).toBeTruthy();
    expect(within(nav).getAllByRole("button", { name: "New channel" }).length).toBeGreaterThan(0);
    expect(within(nav).getAllByRole("button", { name: "New message" }).length).toBe(2);
    // Icons by kind: a lock for private, people for a group, an avatar for a person.
    expect(nav.querySelector('[data-channel="c_management"] .hc-row__icon')).toBeTruthy();
    expect(nav.querySelector('[data-channel="g_u_2_u_3"] .hc-row__icon')).toBeTruthy();
    expect(nav.querySelector('[data-channel="d_anna"] .hc-avatar')).toBeTruthy();
    fireEvent.click(within(nav).getByRole("button", { name: "Browse channels" }));
    expect(chatDialog()?.kind).toBe("browse");
  });

  it("hides New channel when the user may not create channels", async () => {
    tabWidth = 1000;
    await bring();
    sim.setPermissions({ canCreateChannel: false });
    render(() => <ChatTab />);
    const nav = await screen.findByRole("navigation", { name: "Chat navigation" });
    await waitFor(() => expect(within(nav).queryByRole("button", { name: "New channel" })).toBeNull());
    expect(within(nav).getByRole("button", { name: "Browse channels" })).toBeTruthy();
  });
});

describe("threads view", () => {
  it("lists the threads, can filter to unread ones and opens one with its panel", async () => {
    tabWidth = 1000;
    await bring();
    render(() => <ChatTab />);
    fireEvent.click(await screen.findByRole("button", { name: /^Threads/ }));
    const view = await screen.findByTestId("chat-threads");
    await waitFor(() => expect(view.querySelectorAll(".hc-thr")).toHaveLength(3));
    expect(view.querySelector('.hc-thr[data-unread] .ui-badge')?.textContent).toBe("1");
    fireEvent.click(within(view).getByRole("switch", { name: /Unread only/ }));
    await waitFor(() => expect(view.querySelectorAll(".hc-thr")).toHaveLength(1));
    fireEvent.click(view.querySelector(".hc-thr")!);
    const pane = await threadPane();
    expect(await within(pane).findByText("Köszönöm, ez sokat segít!")).toBeTruthy();
    expect(threadPanel()?.rootId).toBe("m_c_general_4");
    expect(screen.getByRole("option", { name: /^#general/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("shows an empty state when nothing has news", async () => {
    tabWidth = 1000;
    await bring("empty");
    render(() => <ChatTab />);
    fireEvent.click(await screen.findByRole("button", { name: /^Threads/ }));
    expect(await screen.findByText("No threads yet")).toBeTruthy();
  });
});

describe("thread panel", () => {
  it("opens from the reply footer and from the hover action, with replies only in the panel", async () => {
    tabWidth = 1000;
    await bring();
    render(() => <ChatTab />);
    const conv = await openRow(/^#dev/);
    await within(conv).findAllByTestId("chat-message");
    // Thread replies never show inline in the channel.
    expect(conv.querySelector('[data-msg^="r_"]')).toBeNull();
    const root = msgEl(conv, "m_c_dev_4");
    fireEvent.click(within(root).getByRole("button", { name: /^Open thread: 3 replies/ }));
    const pane = await threadPane();
    expect(await within(pane).findByText("Rendben, akkor jóváhagyom.")).toBeTruthy();
    expect(within(pane).getAllByRole("separator").some((x) => x.textContent === "3 replies")).toBe(true);
    // Inside the panel a reply has no "Reply in thread" action.
    expect(within(msgEl(pane, "r_m_c_dev_4_1")).queryByRole("button", { name: "Reply in thread" })).toBeNull();
    fireEvent.click(within(pane).getByRole("button", { name: "Close thread" }));
    await waitFor(() => expect(screen.queryByTestId("chat-thread")).toBeNull());

    fireEvent.click(within(msgEl(conv, "m_c_dev_2")).getByRole("button", { name: "Reply in thread" }));
    const second = await threadPane();
    expect(second.getAttribute("data-root")).toBe("m_c_dev_2");
    expect(await within(second).findByText("No replies yet. Start the conversation below.")).toBeTruthy();
  });

  it("posts a reply in the panel (not in the channel) with Enter, keeping a draft per thread", async () => {
    tabWidth = 1000;
    await bring();
    render(() => <ChatTab />);
    const conv = await openRow(/^#dev/);
    fireEvent.click(within(await devRoot(conv)).getByRole("button", { name: /^Open thread/ }));
    const pane = await threadPane();
    const box = () => within(pane).getByRole("textbox", { name: "Reply in thread" }) as HTMLTextAreaElement;
    expect(box().placeholder).toBe("Reply…");
    fireEvent.input(box(), { target: { value: "félig kész válasz" } });
    fireEvent.click(within(pane).getByRole("button", { name: "Close thread" }));
    fireEvent.click(within(msgEl(conv, "m_c_dev_4")).getByRole("button", { name: /^Open thread/ }));
    const again = await threadPane();
    expect((within(again).getByRole("textbox", { name: "Reply in thread" }) as HTMLTextAreaElement).value).toBe("félig kész válasz");

    const send = vi.spyOn(ipc.happy.chat, "send");
    const field = within(again).getByRole("textbox", { name: "Reply in thread" });
    fireEvent.input(field, { target: { value: "Ez egy válasz" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(await within(again).findByText("Ez egy válasz")).toBeTruthy();
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]!.slice(0, 2)).toEqual(["c_dev", "Ez egy válasz"]);
    expect(send.mock.calls[0]![3]).toMatchObject({ threadRootId: "m_c_dev_4" });
    await flush();
    expect(within(conv).queryByText("Ez egy válasz")).toBeNull();
    expect(within(again).getAllByText("Ez egy válasz")).toHaveLength(1);
    // The root in the channel now says 4 replies.
    await waitFor(() => expect(within(msgEl(conv, "m_c_dev_4")).getByRole("button", { name: /^Open thread: 4 replies/ })).toBeTruthy());
  });

  it("switching the open thread drops the old draft and sends only to the new thread (C5)", async () => {
    tabWidth = 1000;
    await bring();
    render(() => <ChatTab />);
    const conv = await openRow(/^#dev/);
    await within(conv).findAllByTestId("chat-message");
    fireEvent.click(within(msgEl(conv, "m_c_dev_4")).getByRole("button", { name: /^Open thread/ }));
    const pane = await threadPane();
    fireEvent.input(within(pane).getByRole("textbox", { name: "Reply in thread" }), { target: { value: "A piszkozat" } });
    fireEvent.click(within(msgEl(conv, "m_c_dev_2")).getByRole("button", { name: "Reply in thread" }));
    await waitFor(async () => expect((await threadPane()).getAttribute("data-root")).toBe("m_c_dev_2"));
    const second = await threadPane();
    const box = within(second).getByRole("textbox", { name: "Reply in thread" }) as HTMLTextAreaElement;
    expect(box.value).toBe("");
    const send = vi.spyOn(ipc.happy.chat, "send");
    fireEvent.input(box, { target: { value: "B válasz" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![3]).toMatchObject({ threadRootId: "m_c_dev_2" });
    expect(threadOf("m_c_dev_4")).toBeUndefined();
    // A's draft is parked under A's key, not lost.
    fireEvent.click(within(msgEl(conv, "m_c_dev_4")).getByRole("button", { name: /^Open thread/ }));
    await waitFor(async () => expect((await threadPane()).getAttribute("data-root")).toBe("m_c_dev_4"));
    expect((within(await threadPane()).getByRole("textbox", { name: "Reply in thread" }) as HTMLTextAreaElement).value).toBe("A piszkozat");
  });

  it("a second Enter while the first send is still collecting extras sends once (C8)", async () => {
    await bring();
    render(() => <ChatTab />);
    await openRow(/^#dev/);
    let release!: () => void;
    registerChatComposerExtension({ id: "slow", collect: () => new Promise((r) => (release = () => r({}))) } as never);
    const send = vi.spyOn(ipc.happy.chat, "send");
    type("egyszer");
    enter();
    enter();
    await flush();
    release();
    await flush();
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed reply with Retry", async () => {
    tabWidth = 1000;
    await bring();
    render(() => <ChatTab />);
    const conv = await openRow(/^#dev/);
    fireEvent.click(within(await devRoot(conv)).getByRole("button", { name: /^Open thread/ }));
    const pane = await threadPane();
    sim.failNext("offline");
    const field = within(pane).getByRole("textbox", { name: "Reply in thread" });
    fireEvent.input(field, { target: { value: "elakadt" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(await within(pane).findByText("Not sent: offline")).toBeTruthy();
    fireEvent.click(within(pane).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(within(pane).queryByText(/Not sent/)).toBeNull());
    expect(within(pane).getAllByText("elakadt")).toHaveLength(1);
  });

  it("shows a reply that arrives live in the panel and keeps it out of the channel", async () => {
    tabWidth = 1000;
    await bring();
    render(() => <ChatTab />);
    const conv = await openRow(/^#dev/);
    fireEvent.click(within(await devRoot(conv)).getByRole("button", { name: /^Open thread/ }));
    const pane = await threadPane();
    sim.receiveReply("m_c_dev_4", "élő válasz");
    expect(await within(pane).findByText("élő válasz")).toBeTruthy();
    expect(within(conv).queryByText("élő válasz")).toBeNull();
  });

  it("is a drawer over the conversation from 560 px, closes with Esc and gives focus back to the opener", async () => {
    tabWidth = 700;
    await bring();
    render(() => <ChatTab />);
    const conv = await openRow(/^#dev/);
    const opener = within(await devRoot(conv)).getByRole("button", { name: /^Open thread/ });
    opener.focus();
    fireEvent.click(opener);
    const pane = await threadPane();
    const aside = pane.closest(".hc-rp") as HTMLElement;
    expect(aside.hasAttribute("data-overlay")).toBe(true);
    expect(aside.closest(".hc-main")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(aside));
    fireEvent.keyDown(aside, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("chat-thread")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("sits beside the conversation from 900 px and covers it entirely in the single column", async () => {
    tabWidth = 1000;
    await bring();
    render(() => <ChatTab />);
    let conv = await openRow(/^#dev/);
    fireEvent.click(within(await devRoot(conv)).getByRole("button", { name: /^Open thread/ }));
    let aside = (await threadPane()).closest(".hc-rp") as HTMLElement;
    expect(aside.hasAttribute("data-overlay")).toBe(false);
    expect(aside.parentElement?.classList.contains("hc-cols")).toBe(true);
    cleanup();
    tabWidth = 400;
    render(() => <ChatTab />);
    aside = (await threadPane()).closest(".hc-rp") as HTMLElement;
    expect(aside.hasAttribute("data-overlay")).toBe(true);
    expect(aside.parentElement?.classList.contains("hc-single")).toBe(true);
    conv = screen.getByTestId("chat-conversation");
    expect(conv).toBeTruthy();
  });
});

describe("message actions", () => {
  /** Sends a message of the user in #dev and returns its element. */
  async function mine(text: string) {
    const conv = await openRow(/^#dev/);
    type(text);
    enter();
    const found = await within(conv).findByText(text, { selector: ".hc-msg__text" });
    await waitFor(() => expect(conv.querySelector("[data-mine][data-state='sent'] .hc-msg__text")).toBeTruthy());
    return { conv, el: found.closest<HTMLElement>(".hc-msg")! };
  }
  const choose = async (el: HTMLElement, action: string) => {
    fireEvent.click(within(el).getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: action }));
  };

  it("edits an own message inline: Enter saves, Esc cancels, and it says (edited)", async () => {
    await bring();
    render(() => <ChatTab />);
    const { el } = await mine("régi szöveg");
    const edit = vi.spyOn(ipc.happy.chat, "edit");
    await choose(el, "Edit");
    let box = within(el).getByRole("textbox", { name: "Edit message" });
    fireEvent.input(box, { target: { value: "elvetett" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(within(el).queryByRole("textbox", { name: "Edit message" })).toBeNull();
    expect(edit).not.toHaveBeenCalled();
    await choose(el, "Edit");
    box = within(el).getByRole("textbox", { name: "Edit message" });
    fireEvent.input(box, { target: { value: "új szöveg" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(edit).toHaveBeenCalledWith(expect.any(String), "új szöveg"));
    expect(await within(el).findByText("új szöveg")).toBeTruthy();
    expect(within(el).getByText("(edited)")).toBeTruthy();
  });

  it("asks before deleting an own message and leaves a muted line", async () => {
    await bring();
    render(() => <ChatTab />);
    const { el } = await mine("törlendő");
    const remove = vi.spyOn(ipc.happy.chat, "remove");
    await choose(el, "Delete");
    expect(within(el).getByText("Delete this message?")).toBeTruthy();
    fireEvent.click(within(within(el).getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(remove).not.toHaveBeenCalled();
    await choose(el, "Delete");
    fireEvent.click(within(within(el).getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect(await within(el).findByText("This message was deleted")).toBeTruthy();
  });

  it("offers Edit and Delete only on own messages", async () => {
    await bring();
    render(() => <ChatTab />);
    const conv = await openRow(/^#dev/);
    const other = await within(conv).findAllByTestId("chat-message");
    const theirs = other.find((m) => !m.hasAttribute("data-mine") && m.querySelector(".hc-msg__actions"))!;
    fireEvent.click(within(theirs).getByRole("button", { name: "More actions" }));
    expect(await screen.findByRole("menuitem", { name: "Pin" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Copy text" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
  });

  it("reacts with an emoji from the popover and toggles it from the chip", async () => {
    await bring();
    render(() => <ChatTab />);
    const { el } = await mine("reakció kell");
    const react = vi.spyOn(ipc.happy.chat, "react");
    fireEvent.click(within(el).getByRole("button", { name: "Add reaction" }));
    fireEvent.click(await screen.findByRole("button", { name: "👍" }));
    await waitFor(() => expect(react).toHaveBeenCalledWith(expect.any(String), "👍"));
    const chip = await within(el).findByRole("button", { name: "👍 1, including you" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip);
    await waitFor(() => expect(react).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(el).queryByRole("button", { name: /👍/ })).toBeNull());
  });

  it("pins and unpins a message", async () => {
    await bring();
    render(() => <ChatTab />);
    const { el } = await mine("kitűzendő");
    const pin = vi.spyOn(ipc.happy.chat, "pin");
    await choose(el, "Pin");
    await waitFor(() => expect(pin).toHaveBeenCalledWith(expect.any(String), true));
    expect(await within(el).findByText("Pinned")).toBeTruthy();
    await choose(el, "Unpin");
    await waitFor(() => expect(pin).toHaveBeenLastCalledWith(expect.any(String), false));
  });
});

describe("composer mentions", () => {
  it("opens a people list at @name, inserts the pick with Enter and sends the user ids", async () => {
    await bring();
    render(() => <ChatTab />);
    await openRow(/^#dev/);
    const send = vi.spyOn(ipc.happy.chat, "send");
    type("Szia @Réka");
    const list = await screen.findByRole("listbox", { name: "People to mention" });
    const option = within(list).getByRole("option", { name: /Szabó Réka/ });
    expect(option.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(composer(), { key: "Enter" });
    expect(composer().value).toBe("Szia @Szabó Réka ");
    expect(screen.queryByRole("listbox", { name: "People to mention" })).toBeNull();
    expect(send).not.toHaveBeenCalled();
    type("Szia @Szabó Réka nézd meg");
    enter();
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const person = (await ipc.happy.chat.people("Réka")).find((p) => p.name === "Szabó Réka")!;
    expect(send.mock.calls[0]![3]).toEqual({ mentions: [person.id] });
  });

  it("closes the list with Escape without leaving the conversation", async () => {
    await bring();
    render(() => <ChatTab />);
    await openRow(/^#dev/);
    type("@Réka");
    await screen.findByRole("listbox", { name: "People to mention" });
    fireEvent.keyDown(composer(), { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "People to mention" })).toBeNull();
    expect(screen.getByTestId("chat-conversation")).toBeTruthy();
  });
});

describe("jump to a message", () => {
  it("shows a Jump to latest pill in a jump window and returns to the newest page", async () => {
    await bring("big");
    render(() => <ChatTab />);
    const conv = await openRow(/^#dev/);
    await within(conv).findAllByTestId("chat-message");
    await jumpToMessage("c_dev", "m_c_dev_10");
    const pill = await within(conv).findByRole("button", { name: "Jump to latest" });
    await waitFor(() => expect(msgEl(conv, "m_c_dev_10")).toBeTruthy());
    const open = vi.spyOn(ipc.happy.chat, "open");
    fireEvent.click(pill);
    await waitFor(() => expect(open).toHaveBeenCalledWith("c_dev"));
    await waitFor(() => expect(within(conv).queryByRole("button", { name: "Jump to latest" })).toBeNull());
  });
});

describe("<MessageRow> kinds", () => {
  const base: ChatMessage = {
    id: "x1", channelId: "c_dev", clientMessageId: null, senderId: "u_2", senderName: "Kovács Anna", text: "szöveg", createdAtMs: Date.now(), edited: false, deleted: false, system: false, mine: false, mentionsMe: false,
    sendState: "sent", errorCode: null, kind: "text", threadRoot: null, replyCount: 0, lastReplyAtMs: null, replyUsers: [], reactions: [], attachments: [], pinned: false,
  };
  it("renders system lines muted, meeting and record cards, attachments and a deleted stub", async () => {
    await bring();
    render(() => (
      <>
        <MessageRow msg={{ ...base, id: "s", kind: "system", system: true, text: "Anna joined" }} grouped={false} known={[]} />
        <MessageRow msg={{ ...base, id: "m", kind: "meeting", text: "Daily standup" }} grouped={false} known={[]} />
        <MessageRow msg={{ ...base, id: "f", attachments: [{ name: "terv.pdf", mimeType: "application/pdf", size: 1536 }] }} grouped={false} known={[]} />
        <MessageRow msg={{ ...base, id: "d", deleted: true, text: "" }} grouped={false} known={[]} />
      </>
    ));
    expect(screen.getByText("Anna joined").classList.contains("hc-system")).toBe(true);
    expect(document.querySelector('.hc-card[data-kind="meeting"]')?.textContent).toContain("Daily standup");
    expect(screen.getByLabelText("Attachment terv.pdf").textContent).toContain("1.5 KB");
    expect(screen.getByText("This message was deleted")).toBeTruthy();
    // A deleted message has no actions.
    expect(document.querySelector('[data-msg="d"] .hc-msg__actions')).toBeNull();
  });
});
