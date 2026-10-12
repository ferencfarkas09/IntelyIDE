import { describe, expect, it } from "vitest";
import { isRelayOld, messageOf } from "./store";

describe("team failures as text", () => {
  it("names an old relay and how to fix it", () => {
    const e = { code: "relayOld", message: "x" };
    expect(isRelayOld(e)).toBe(true);
    expect(messageOf(e)).toMatch(/does not support teams yet/);
  });

  it("turns the relay's raw transport codes into sentences and keeps other messages", () => {
    expect(messageOf({ code: "relay", message: "create:500" })).toMatch(/HTTP 500/);
    expect(messageOf({ code: "relay", message: "timeout" })).toMatch(/did not answer/);
    expect(messageOf({ code: "relay", message: "http" })).toMatch(/could not be reached/);
    expect(messageOf({ code: "inviteSpent", message: "the invite is expired" })).toBe("the invite is expired");
  });
});
