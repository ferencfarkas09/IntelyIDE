import { describe, expect, it } from "vitest";
import { cleanChannelName, MAX_CHANNEL_NAME, MUTE_FOREVER_MS, muteUntil, nameFieldError } from "./dialogs-logic";

describe("cleanChannelName", () => {
  it("strips # and whitespace", () => {
    expect(cleanChannelName("  ##  design   team ")).toBe("design team");
    expect(cleanChannelName("#")).toBe("");
  });
  it("caps the length", () => {
    expect(cleanChannelName("x".repeat(200))).toHaveLength(MAX_CHANNEL_NAME);
  });
});

describe("muteUntil", () => {
  const now = new Date(2026, 9, 6, 15, 30).getTime();
  it("hour / forever", () => {
    expect(muteUntil("hour", now)).toBe(now + 3_600_000);
    expect(muteUntil("forever", now)).toBe(MUTE_FOREVER_MS);
  });
  it("tomorrow is 08:00 the next day", () => {
    const d = new Date(muteUntil("tomorrow", now));
    expect([d.getDate(), d.getHours(), d.getMinutes()]).toEqual([7, 8, 0]);
  });
});

describe("nameFieldError", () => {
  it("only the name codes", () => {
    expect(nameFieldError("CHANNEL_NAME_TAKEN")).toBe(true);
    expect(nameFieldError("CREATE_FORBIDDEN")).toBe(false);
  });
});
