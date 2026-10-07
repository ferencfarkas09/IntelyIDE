import { describe, expect, it } from "vitest";
import { utf8 } from "../noise/bytes";
import { decodePairReply, decodeServer } from "./wire";

const body = (o: object) => utf8(JSON.stringify({ v: 1, ...o }));

describe("welcome message", () => {
  it("is a known server message", () => {
    expect(decodeServer(body({ t: "welcome", bundlePub: "x" }))).toMatchObject({ t: "welcome", bundlePub: "x" });
  });
  it("is a known pairing reply, only with a string key", () => {
    expect(decodePairReply(body({ t: "welcome", bundlePub: "k" }))).toMatchObject({ t: "welcome" });
    expect(decodePairReply(body({ t: "welcome" }))).toBeNull();
    expect(decodePairReply(body({ t: "welcome", bundlePub: 5 }))).toBeNull();
  });
  it("unknown tags are still dropped", () => {
    expect(decodeServer(body({ t: "evil" }))).toBeNull();
  });
});
