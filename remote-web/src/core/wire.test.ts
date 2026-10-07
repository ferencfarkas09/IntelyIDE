import { describe, expect, it } from "vitest";
import { utf8 } from "../noise/bytes";
import { decodePairReply, decodeServer, encode, newOpId, visible } from "./wire";

describe("wire", () => {
  it("stamps the protocol version on every message", () => {
    expect(JSON.parse(new TextDecoder().decode(encode({ t: "ping" })))).toEqual({ t: "ping", v: 1 });
  });

  it("decodes only known server messages of version 1 (fail closed)", () => {
    expect(decodeServer(utf8('{"t":"pong","v":1}'))).toEqual({ t: "pong" });
    expect(decodeServer(utf8('{"t":"pong","v":2}'))).toBeNull();
    expect(decodeServer(utf8('{"t":"pong"}'))).toBeNull();
    expect(decodeServer(utf8('{"t":"rm -rf","v":1}'))).toBeNull();
    expect(decodeServer(utf8("[1]"))).toBeNull();
    expect(decodeServer(utf8("not json"))).toBeNull();
    expect(decodeServer(new Uint8Array(70_000))).toBeNull();
  });

  it("decodes pairing replies", () => {
    expect(decodePairReply(utf8('{"t":"rejected","reason":"no","v":1}'))).toMatchObject({ t: "rejected" });
    expect(decodePairReply(utf8('{"t":"accepted","deviceId":"d","deviceToken":"t","capability":"view","macName":"m","v":1}'))).toMatchObject({ t: "accepted", capability: "view" });
    expect(decodePairReply(utf8('{"t":"accepted","v":1}'))).toBeNull();
  });

  it("escapes invisible and bidirectional characters so a command cannot hide what it does", () => {
    expect(visible("ls‮ gpj.sh")).toBe("ls\\u{202e} gpj.sh");
    expect(visible("a​b\u0007c")).toBe("a\\u{200b}b\\u{7}c");
    expect(visible("plain ünïcode ✓")).toBe("plain ünïcode ✓");
  });

  it("makes unique idempotency keys", () => {
    expect(new Set(Array.from({ length: 50 }, newOpId)).size).toBe(50);
  });
});
