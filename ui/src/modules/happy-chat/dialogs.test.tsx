import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import type { ChatPerson } from "../../ipc/happy";
import type { MockChatSim } from "../../ipc/mock/happy";
import { createMockHappy } from "../../ipc/mock/happy";
import { resetOverlays } from "../../platform/overlay";
import { startHappyWatch } from "../../store/happy";
import { installDomStubs } from "../../store/testing-u2";
import { toast } from "../../ui-kit";
import { BrowseChannelsDialog } from "./BrowseChannelsDialog";
import { ChannelHeader } from "./ChannelHeader";
import { ChatDialogs } from "./ChatDialogs";
import { closeChatDialog, closeMembers, membersPanelOpen, openBrowseChannels, openMembers, openNewChannel, openNewMessage, openSearch } from "./dialogs";
import { MembersPanel } from "./MembersPanel";
import { NewChannelDialog } from "./NewChannelDialog";
import { NewMessageDialog } from "./NewMessageDialog";
import { PeoplePicker } from "./PeoplePicker";
import { SearchDialog } from "./SearchDialog";
import { activeChannelId, channelOf, chatSummary, resetChat, setActiveChannel, startChat } from "./state";

installDomStubs();

const original = ipc.happy;
const flush = () => new Promise((r) => setTimeout(r, 0));
let stops: (() => void)[] = [];
let sim: MockChatSim;

async function bring() {
  const happy = createMockHappy({ preset: "connected", chat: "ok" });
  sim = happy.chatSim;
  (ipc as { happy: unknown }).happy = happy;
  const status = await happy.status();
  vi.spyOn(ipc.settings, "get").mockResolvedValue(status.config);
  stops.push(startHappyWatch());
  await flush();
  await flush();
  stops.push(startChat());
  await flush();
  await flush();
}

const ch = (id: string) => channelOf(id)!;

beforeEach(() => setActiveChannel(undefined));
afterEach(() => {
  cleanup();
  closeChatDialog();
  closeMembers();
  stops.forEach((s) => s());
  stops = [];
  resetChat();
  resetOverlays();
  toast.clear();
  (ipc as { happy: unknown }).happy = original;
  vi.restoreAllMocks();
});

describe("PeoplePicker", () => {
  function Harness(p: { max?: number; exclude?: string[]; onChange?: (s: ChatPerson[]) => void }) {
    const [sel, setSel] = createSignal<ChatPerson[]>([]);
    return <PeoplePicker label="People" selected={sel()} max={p.max} exclude={p.exclude} onChange={(s) => (setSel(s), p.onChange?.(s))} />;
  }

  it("lists the directory, picks with arrows + Enter and removes chips", async () => {
    await bring();
    const seen: ChatPerson[][] = [];
    render(() => <Harness onChange={(s) => seen.push(s)} />);
    const input = screen.getByRole("combobox", { name: "People" });
    await screen.findByRole("option", { name: /Kovács Anna/ });
    expect(screen.getByRole("listbox", { name: "People" })).toBeTruthy();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(seen.at(-1)?.map((p) => p.name)).toEqual(["Nagy Péter"]);
    // The chosen person leaves the list and shows as a chip.
    expect(screen.queryByRole("option", { name: /Nagy Péter/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove Nagy Péter" }));
    expect(seen.at(-1)).toEqual([]);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(seen.at(-1)).toEqual([]);
  });

  it("filters by search, excludes ids and reports an empty result", async () => {
    await bring();
    render(() => <Harness exclude={["u_2"]} />);
    await screen.findByRole("option", { name: /Nagy Péter/ });
    expect(screen.queryByRole("option", { name: /Kovács Anna/ })).toBeNull();
    fireEvent.input(screen.getByRole("combobox"), { target: { value: "zzzz" } });
    expect(await screen.findByText(/Nobody matches "zzzz"/)).toBeTruthy();
  });

  it("stops at the maximum", async () => {
    await bring();
    render(() => <Harness max={1} />);
    const input = screen.getByRole("combobox");
    await screen.findByRole("option", { name: /Kovács Anna/ });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("You can pick up to 1 people")).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("shows an error with a retry", async () => {
    await bring();
    const spy = vi.spyOn(ipc.happy.chat, "people").mockRejectedValueOnce({ code: "x", message: "boom" });
    render(() => <Harness />);
    expect(await screen.findByText("Could not load people")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("option", { name: /Kovács Anna/ });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("NewChannelDialog", () => {
  it("creates a public channel with Enter, selects it and closes", async () => {
    await bring();
    const onClose = vi.fn();
    render(() => <NewChannelDialog open onClose={onClose} />);
    const name = await screen.findByLabelText("Name");
    fireEvent.input(name, { target: { value: "  #kitchen  orders " } });
    fireEvent.keyDown(name, { key: "Enter" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const made = chatSummary()!.channels.find((c) => c.name === "kitchen orders");
    expect(made?.kind).toBe("channel");
    expect(activeChannelId()).toBe(made?.id);
  });

  it("creates a private channel with members", async () => {
    await bring();
    const onClose = vi.fn();
    render(() => <NewChannelDialog open onClose={onClose} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Private/ }));
    fireEvent.input(screen.getByLabelText("Name"), { target: { value: "secret" } });
    fireEvent.click(await screen.findByRole("option", { name: /Kovács Anna/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create channel" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const made = chatSummary()!.channels.find((c) => c.name === "secret")!;
    expect(made.kind).toBe("private");
    expect(made.memberCount).toBe(2);
  });

  it("needs a name", async () => {
    await bring();
    render(() => <NewChannelDialog open onClose={() => {}} />);
    const create = await screen.findByRole("button", { name: "Create channel" });
    expect(create.hasAttribute("disabled")).toBe(true);
  });

  it("puts a taken name on the name field and stays open", async () => {
    await bring();
    const onClose = vi.fn();
    render(() => <NewChannelDialog open onClose={onClose} />);
    const name = await screen.findByLabelText("Name");
    const taken = chatSummary()!.channels.find((c) => c.kind === "channel")!.name;
    fireEvent.input(name, { target: { value: taken } });
    fireEvent.keyDown(name, { key: "Enter" });
    const err = await screen.findByText("A channel with this name already exists");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(err.getAttribute("role")).toBe("alert");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows the friendly refusal when creating is forbidden", async () => {
    await bring();
    sim.setPermissions({ canCreateChannel: false });
    const onClose = vi.fn();
    render(() => <NewChannelDialog open onClose={onClose} />);
    fireEvent.input(await screen.findByLabelText("Name"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Create channel" }));
    expect(await screen.findByText("You are not allowed to create channels in this store")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("BrowseChannelsDialog", () => {
  it("lists unjoined public channels and joining opens the channel", async () => {
    await bring();
    const onClose = vi.fn();
    render(() => <BrowseChannelsDialog open onClose={onClose} />);
    const join = await screen.findByRole("button", { name: "Join design" });
    expect(screen.queryByRole("button", { name: "Join general" })).toBeNull();
    fireEvent.click(join);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(ch("c_design").isMember).toBe(true);
    expect(activeChannelId()).toBe("c_design");
  });

  it("searches", async () => {
    await bring();
    render(() => <BrowseChannelsDialog open onClose={() => {}} />);
    await screen.findByRole("button", { name: "Join design" });
    fireEvent.input(screen.getByRole("searchbox", { name: "Search channels" }), { target: { value: "zzzz" } });
    expect(await screen.findByText('No channel matches "zzzz"')).toBeTruthy();
  });
});

describe("NewMessageDialog", () => {
  it("starts a direct message and a group conversation", async () => {
    await bring();
    const onClose = vi.fn();
    render(() => <NewMessageDialog open onClose={onClose} />);
    expect(await screen.findByText("2 or more people make a group conversation")).toBeTruthy();
    const start = screen.getByRole("button", { name: "Start conversation" });
    expect(start.hasAttribute("disabled")).toBe(true);
    fireEvent.click(await screen.findByRole("option", { name: /Szabó Réka/ }));
    fireEvent.click(await screen.findByRole("option", { name: /Tóth Gábor/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start group conversation" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const opened = channelOf(activeChannelId())!;
    expect(opened.kind).toBe("group");
    expect(opened.peers).toHaveLength(2);
  });

  it("reuses an existing direct conversation", async () => {
    await bring();
    render(() => <NewMessageDialog open onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("option", { name: /Kovács Anna/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start conversation" }));
    await waitFor(() => expect(activeChannelId()).toBe("d_anna"));
  });
});

describe("SearchDialog", () => {
  it("groups results and opens a message", async () => {
    await bring();
    const onClose = vi.fn();
    render(() => <SearchDialog open onClose={onClose} />);
    const box = screen.getByRole("combobox", { name: "Search messages, channels and people" });
    fireEvent.input(box, { target: { value: "a" } });
    expect(screen.getByText("Type at least 2 characters to search")).toBeTruthy();
    fireEvent.input(box, { target: { value: "standup" } });
    const hit = await screen.findAllByRole("option");
    expect(screen.getByRole("group", { name: "Messages" })).toBeTruthy();
    fireEvent.click(hit[0]!);
    expect(onClose).toHaveBeenCalled();
    expect(activeChannelId()).toBeTruthy();
  });

  it("limits to a channel and can widen", async () => {
    await bring();
    const search = vi.spyOn(ipc.happy.chat, "search");
    render(() => <SearchDialog open channelId="c_general" onClose={() => {}} />);
    fireEvent.input(screen.getByRole("combobox"), { target: { value: "standup" } });
    await waitFor(() => expect(search).toHaveBeenCalledWith("standup", "c_general"));
    fireEvent.click(screen.getByRole("radio", { name: "Everywhere" }));
    await waitFor(() => expect(search).toHaveBeenCalledWith("standup", undefined));
  });

  it("finds people and starts a direct conversation", async () => {
    await bring();
    const onClose = vi.fn();
    render(() => <SearchDialog open onClose={onClose} />);
    fireEvent.input(screen.getByRole("combobox"), { target: { value: "Szabó" } });
    const person = await screen.findByRole("option", { name: /Szabó Réka/ });
    fireEvent.click(person);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(channelOf(activeChannelId())?.peers.map((p) => p.name)).toEqual(["Szabó Réka"]);
  });
});

describe("ChatDialogs host", () => {
  it("opens each dialog from its opener", async () => {
    await bring();
    render(() => <ChatDialogs />);
    openNewChannel();
    expect(await screen.findByRole("dialog", { name: "Create a channel" })).toBeTruthy();
    openBrowseChannels();
    expect(await screen.findByRole("dialog", { name: "Browse channels" })).toBeTruthy();
    openNewMessage();
    expect(await screen.findByRole("dialog", { name: "New message" })).toBeTruthy();
    openSearch("c_general");
    expect(await screen.findByRole("dialog", { name: "Search" })).toBeTruthy();
  });
});

describe("MembersPanel", () => {
  it("lists members, adds people and removes one as an admin", async () => {
    await bring();
    const onClose = vi.fn();
    render(() => <MembersPanel channelId="c_management" onClose={onClose} />);
    const list = await screen.findByRole("list", { name: "Members" });
    const before = (await within(list).findAllByRole("listitem")).length;
    expect(screen.getByRole("heading", { name: `Members (${before})` })).toBeTruthy();
    expect(within(list).getByText("(you)")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add people" }));
    const outsider = (await screen.findAllByRole("option"))[0]!;
    fireEvent.click(outsider);
    fireEvent.click(screen.getByRole("button", { name: "Add 1 person" }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Members" })).getAllByRole("listitem")).toHaveLength(before + 1));
    expect(ch("c_management").memberCount).toBe(before + 1);

    fireEvent.click(screen.getAllByRole("button", { name: /^Remove .* from the channel$/ })[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Members" })).getAllByRole("listitem")).toHaveLength(before));
  });

  it("filters the list and closes with Escape", async () => {
    await bring();
    const onClose = vi.fn();
    render(() => <MembersPanel channelId="c_general" onClose={onClose} />);
    await screen.findByRole("list", { name: "Members" });
    fireEvent.input(screen.getByRole("searchbox", { name: "Find a member" }), { target: { value: "zzzz" } });
    expect(await screen.findByText("No members found")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("complementary"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("hides invite and remove for a private channel without admin rights", async () => {
    await bring();
    sim.setPermissions({ canManageChannels: false });
    await flush();
    render(() => <MembersPanel channelId="c_hr" onClose={() => {}} />);
    await screen.findByRole("list", { name: "Members" });
    expect(screen.queryByRole("button", { name: "Add people" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove .* from the channel$/ })).toBeNull();
  });

  it("explains that direct conversations cannot be extended", async () => {
    await bring();
    render(() => <MembersPanel channelId="d_anna" onClose={() => {}} />);
    expect(await screen.findByText(/People cannot be added to direct conversations/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add people" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New group conversation" }));
  });

  it("shows the server refusal for a forbidden invite", async () => {
    await bring();
    render(() => <MembersPanel channelId="c_management" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add people" }));
    fireEvent.click((await screen.findAllByRole("option"))[0]!);
    vi.spyOn(ipc.happy.chat, "addMembers").mockRejectedValueOnce({ code: "MANAGE_FORBIDDEN", message: "x" });
    fireEvent.click(screen.getByRole("button", { name: "Add 1 person" }));
    expect(await screen.findByText("This private channel needs a channel admin to invite people")).toBeTruthy();
  });

  it("shows an error with a retry", async () => {
    await bring();
    vi.spyOn(ipc.happy.chat, "members").mockRejectedValueOnce({ code: "x", message: "offline" });
    render(() => <MembersPanel channelId="c_general" onClose={() => {}} />);
    expect(await screen.findByText("offline")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("list", { name: "Members" });
  });
});

describe("ChannelHeader", () => {
  it("shows name, topic and the member count and toggles the members panel", async () => {
    await bring();
    render(() => <ChannelHeader channel={ch("c_general")} />);
    expect(screen.getByRole("heading", { name: "general" })).toBeTruthy();
    const members = screen.getByRole("button", { name: /members, show members/ });
    fireEvent.click(members);
    expect(membersPanelOpen()).toBe(true);
    fireEvent.click(members);
    expect(membersPanelOpen()).toBe(false);
    openMembers();
    expect(membersPanelOpen()).toBe(true);
  });

  it("stars and sets notification and mute preferences", async () => {
    await bring();
    render(() => <ChannelHeader channel={channelOf("c_general")!} />);
    fireEvent.click(screen.getByRole("button", { name: "Star this conversation" }));
    await waitFor(() => expect(ch("c_general").starred).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Mentions only" }));
    await waitFor(() => expect(ch("c_general").notifyLevel).toBe("mentions"));
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Mute for 1 hour" }));
    await waitFor(() => expect(ch("c_general").muted).toBe(true));
  });

  it("offers editing only to admins and leaves a channel after confirming", async () => {
    await bring();
    const admin = render(() => <ChannelHeader channel={ch("c_management")} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(await screen.findByRole("menuitem", { name: /Edit name, topic/ })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    admin.unmount();
    cleanup();

    sim.setPermissions({ canManageChannels: false });
    render(() => <ChannelHeader channel={ch("c_hr")} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.queryByRole("menuitem", { name: /Edit name, topic/ })).toBeNull();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Leave channel" }));
    fireEvent.click(await screen.findByRole("button", { name: "Leave channel" }));
    await waitFor(() => expect(channelOf("c_hr")).toBeUndefined());
  });

  it("has no leave action in a direct conversation", async () => {
    await bring();
    render(() => <ChannelHeader channel={ch("d_anna")} onBack={() => {}} />);
    expect(screen.getByRole("button", { name: "Back to the conversation list" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    await screen.findByRole("menuitem", { name: "Search in this channel" });
    expect(screen.queryByRole("menuitem", { name: "Leave channel" })).toBeNull();
  });
});
