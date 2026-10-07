import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTauriChat } from "./happyChat";

const rpc = vi.hoisted(() => ({ call: vi.fn(async (..._a: unknown[]) => undefined), subscribe: vi.fn((..._a: unknown[]) => () => {}) }));
vi.mock("./rpc", () => rpc);

// The command names and argument keys below are the signatures in src-tauri/src/modules/happy_chat.rs (Tauri maps camelCase
// keys to the snake_case Rust parameters). If a Rust signature changes, this test is the place that says so.
describe("Tauri team chat IPC", () => {
  beforeEach(() => rpc.call.mockClear());
  const chat = createTauriChat();
  const calls = () => rpc.call.mock.calls.map(([name, args]) => [name, args === undefined ? undefined : JSON.parse(JSON.stringify(args))]);

  it("calls the happy_chat_* commands with the argument keys Rust expects", async () => {
    await chat.summary();
    await chat.summary(true);
    await chat.open("c1");
    await chat.setActive(true, "c1");
    await chat.setActive(false, null);
    await chat.older("c1", "m9");
    await chat.around("c1", "m5");
    await chat.newer("c1", "m5");
    await chat.send("c1", "szia", "cm-1");
    await chat.markRead("c1");
    await chat.typing("c1");
    await chat.people("an");
    await chat.people();
    expect(calls()).toEqual([
      ["happy_chat_summary", undefined],
      ["happy_chat_refresh", undefined],
      ["happy_chat_open", { channelId: "c1" }],
      ["happy_chat_set_active", { open: true, channelId: "c1" }],
      ["happy_chat_set_active", { open: false, channelId: null }],
      ["happy_chat_older", { channelId: "c1", before: "m9" }],
      ["happy_chat_around", { channelId: "c1", messageId: "m5" }],
      ["happy_chat_newer", { channelId: "c1", after: "m5" }],
      ["happy_chat_send", { channelId: "c1", text: "szia", clientMessageId: "cm-1" }],
      ["happy_chat_mark_read", { channelId: "c1" }],
      ["happy_chat_typing", { channelId: "c1" }],
      ["happy_chat_directory", { query: "an" }],
      ["happy_chat_directory", { query: "" }],
    ]);
  });

  it("sends mentions and the thread root, and opens direct/group conversations with a user id array", async () => {
    await chat.send("c1", "hi @Anna", "cm-2", { mentions: ["u2"], threadRootId: "m1" });
    await chat.direct("u2");
    await chat.direct(["u2", "u3"]);
    expect(calls()).toEqual([
      ["happy_chat_send", { channelId: "c1", text: "hi @Anna", clientMessageId: "cm-2", mentions: ["u2"], threadRootId: "m1" }],
      ["happy_chat_open_direct", { userIds: ["u2"] }],
      ["happy_chat_open_direct", { userIds: ["u2", "u3"] }],
    ]);
  });

  it("calls the thread, channel, member and message commands", async () => {
    await chat.thread("m1");
    await chat.threads();
    await chat.threads(true);
    await chat.browse("de");
    await chat.browse();
    await chat.createChannel({ name: "x", memberIds: ["u2"] });
    await chat.join("c1");
    await chat.leave("c1");
    await chat.updateChannel("c1", { topic: "t" });
    await chat.setPreferences("c1", { starred: true, notifyLevel: "none" });
    await chat.members("c1");
    await chat.addMembers("c1", ["u2"]);
    await chat.removeMember("c1", "u2");
    await chat.edit("m1", "new");
    await chat.remove("c1", "m1");
    await chat.remove("c1", "m2", "m1");
    await chat.react("m1", "👍");
    await chat.pin("m1", true);
    await chat.search("kö", "c1");
    expect(calls()).toEqual([
      ["happy_chat_thread", { rootId: "m1" }],
      ["happy_chat_threads", { unreadOnly: false }],
      ["happy_chat_threads", { unreadOnly: true }],
      ["happy_chat_browse", { query: "de" }],
      ["happy_chat_browse", { query: "" }],
      ["happy_chat_create_channel", { name: "x", description: "", private: false, memberIds: ["u2"] }],
      ["happy_chat_join", { channelId: "c1" }],
      ["happy_chat_leave", { channelId: "c1" }],
      ["happy_chat_update_channel", { channelId: "c1", topic: "t" }],
      ["happy_chat_preferences", { channelId: "c1", notifyLevel: "none", starred: true }],
      ["happy_chat_members", { channelId: "c1" }],
      ["happy_chat_add_members", { channelId: "c1", userIds: ["u2"] }],
      ["happy_chat_remove_member", { channelId: "c1", userId: "u2" }],
      ["happy_chat_edit", { messageId: "m1", text: "new" }],
      ["happy_chat_delete", { channelId: "c1", messageId: "m1" }],
      ["happy_chat_delete", { channelId: "c1", messageId: "m2", threadRootId: "m1" }],
      ["happy_chat_react", { messageId: "m1", emoji: "👍" }],
      ["happy_chat_pin", { messageId: "m1", pinned: true }],
      ["happy_chat_search", { query: "kö", channelId: "c1" }],
    ]);
  });

  it("listens on happy:chat", () => {
    chat.onEvent(() => {});
    expect(rpc.subscribe).toHaveBeenCalledWith("happy:chat", expect.any(Function));
  });
});
