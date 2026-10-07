import { describe, expect, it } from "vitest";
import { formatOffer, parseOffer, type Offer } from "./code";

const offer: Offer = { relayHost: "relay.example.workers.dev", roomId: "r".repeat(22), macPub: new Uint8Array(32).fill(7), otp: new Uint8Array(16).fill(9) };

describe("pairing offer", () => {
  it("round-trips exactly 4 fields", () => {
    const text = formatOffer(offer);
    expect(text.split(",").length).toBe(4);
    const back = parseOffer(text)!;
    expect(back.relayHost).toBe(offer.relayHost);
    expect([...back.macPub]).toEqual([...offer.macPub]);
  });
  it("rejects a fifth field (the build key travels in the Noise channel, not in the QR)", () => {
    expect(parseOffer(formatOffer(offer) + ",AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBeNull();
  });
  it("rejects three fields", () => {
    expect(parseOffer(formatOffer(offer).split(",").slice(0, 3).join(","))).toBeNull();
  });
  it("accepts a whole link", () => {
    expect(parseOffer("https://relay.example.workers.dev/" + formatOffer(offer))).not.toBeNull();
  });
  it("refuses an offer for another relay host when the page host is given", () => {
    expect(parseOffer(formatOffer(offer), "relay.example.workers.dev")).not.toBeNull();
    expect(parseOffer(formatOffer(offer), "evil.example")).toBeNull();
  });
  it("refuses hosts with a path-like or userinfo shape", () => {
    for (const host of ["a/b", "u@h", "h?x", "h#x", ""]) expect(parseOffer(formatOffer({ ...offer, relayHost: host }))).toBeNull();
  });
});
