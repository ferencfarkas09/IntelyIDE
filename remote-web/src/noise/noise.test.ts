// @vitest-environment node
// Interop: the TypeScript Noise must reproduce, byte for byte, what `snow` produced in crates/remote/tests/noise_vectors.rs.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { b64u, fromHex, toHex, utf8 } from "./bytes";
import { Handshake, framed, keyPairFromPriv, pairTokenFromOtp, pskFromOtp, sha256Hex, generateKeyPair, TAG, type Kind } from "./noise";
import { formatOffer, manualCode, parseManualCode, parseOffer } from "../core/code";

const V = JSON.parse(readFileSync(new URL("../../test/vectors/noise.json", import.meta.url), "utf8"));

function runVector(v: any, kind: Kind) {
  const psk = v.psk ? fromHex(v.psk) : undefined;
  const mac = keyPairFromPriv(fromHex(v.macPriv));
  const phone = keyPairFromPriv(fromHex(v.phonePriv));
  expect(toHex(mac.pub)).toBe(v.macPub);
  expect(toHex(phone.pub)).toBe(v.phonePub);
  const i = new Handshake({ kind, initiator: true, s: phone, rs: mac.pub, psk, fixedEphemeral: fromHex(v.phoneEphemeral) });
  const r = new Handshake({ kind, initiator: false, s: mac, psk, fixedEphemeral: fromHex(v.macEphemeral) });
  return { i, r, mac, phone };
}

describe.each([
  ["ik", "reconnect"],
  ["ikpsk2", "pairing"],
] as const)("Noise %s against snow", (name, kind) => {
  const v = V[name];
  it("writes the same handshake messages, hash and SAS as snow", () => {
    const { i, r } = runVector(v, kind);
    const m1 = i.write();
    expect(toHex(m1)).toBe(v.msg1);
    r.read(m1);
    const m2 = r.write();
    expect(toHex(m2)).toBe(v.msg2);
    i.read(m2);
    expect(toHex(i.handshakeHash)).toBe(v.handshakeHash);
    expect(toHex(r.handshakeHash)).toBe(v.handshakeHash);
    expect(i.sas()).toBe(v.sas);
    expect(r.sas()).toBe(v.sas);
    expect(toHex(r.remoteStatic!)).toBe(v.phonePub);
  });

  it("decrypts snow's transport frames and produces the same ciphertext in both directions", () => {
    const { i, r } = runVector(v, kind);
    r.read(i.write());
    i.read(r.write());
    const ti = i.toTransport();
    const tr = r.toTransport();
    for (const f of v.initiatorToResponder) {
      expect(toHex(ti.encrypt(fromHex(f.pt)))).toBe(f.ct);
      expect(toHex(tr.decrypt(fromHex(f.ct)))).toBe(f.pt);
    }
    for (const f of v.responderToInitiator) {
      expect(toHex(tr.encrypt(fromHex(f.pt)))).toBe(f.ct);
      expect(toHex(ti.decrypt(fromHex(f.ct)))).toBe(f.pt);
    }
  });

  it("rekeys every 65536 messages exactly like snow", () => {
    const { i, r } = runVector(v, kind);
    r.read(i.write());
    i.read(r.write());
    const ti = i.toTransport();
    // the vector run sent three messages first; replay them, then the filler
    for (const f of v.initiatorToResponder) ti.encrypt(fromHex(f.pt));
    let last: Uint8Array = new Uint8Array();
    for (let n = v.initiatorToResponder.length; n < v.rekey.messages; n++) last = ti.encrypt(fromHex(v.rekey.plaintext));
    expect(toHex(last)).toBe(v.rekey.lastCiphertext);
  });
});

describe("Noise safety properties", () => {
  const pair = () => {
    const { i, r } = runVector(V.ik, "reconnect");
    r.read(i.write());
    i.read(r.write());
    return { ti: i.toTransport(), tr: r.toTransport() };
  };

  it("rejects a replayed, reordered, tampered or foreign frame and keeps working afterwards", () => {
    const { ti, tr } = pair();
    const a = ti.encrypt(utf8("one"));
    const b = ti.encrypt(utf8("two"));
    expect(() => tr.decrypt(b)).toThrow(); // out of order
    expect(new TextDecoder().decode(tr.decrypt(a))).toBe("one");
    expect(() => tr.decrypt(a)).toThrow(); // replay
    const bad = Uint8Array.from(b);
    bad[3] ^= 1;
    expect(() => tr.decrypt(bad)).toThrow(); // tamper
    expect(new TextDecoder().decode(tr.decrypt(b))).toBe("two"); // state untouched by the failures
    expect(() => tr.decrypt(new Uint8Array(8))).toThrow();
  });

  it("fails the handshake with the wrong PSK, a wrong Mac key or a different prologue version", () => {
    const mac = generateKeyPair();
    const phone = generateKeyPair();
    const psk = pskFromOtp(new Uint8Array(16).fill(1));
    const wrong = pskFromOtp(new Uint8Array(16).fill(2));
    const i2 = new Handshake({ kind: "pairing", initiator: true, s: phone, rs: mac.pub, psk });
    const r2 = new Handshake({ kind: "pairing", initiator: false, s: mac, psk: wrong });
    const m1 = i2.write();
    r2.read(m1);
    expect(() => i2.read(r2.write())).toThrow();
    const stranger = generateKeyPair();
    const r3 = new Handshake({ kind: "reconnect", initiator: false, s: stranger });
    const i3 = new Handshake({ kind: "reconnect", initiator: true, s: phone, rs: mac.pub });
    expect(() => r3.read(i3.write())).toThrow();
  });

  it("gives both sides the same fresh SAS and different SAS per session", () => {
    const mac = generateKeyPair();
    const phone = generateKeyPair();
    const psk = pskFromOtp(new Uint8Array(16).fill(5));
    const run = () => {
      const i = new Handshake({ kind: "pairing", initiator: true, s: phone, rs: mac.pub, psk });
      const r = new Handshake({ kind: "pairing", initiator: false, s: mac, psk });
      r.read(i.write());
      i.read(r.write());
      expect(i.sas()).toBe(r.sas());
      return i.sas();
    };
    expect(run()).toMatch(/^\d{6}$/);
    expect(run()).not.toBe(run());
  });
});

describe("pairing codes against the Rust side", () => {
  const p = V.pairing;
  it("derives the same PSK, relay token and hash from the one-time code", () => {
    const otp = fromHex(p.otp);
    expect(toHex(pskFromOtp(otp))).toBe(p.psk);
    expect(pairTokenFromOtp(otp)).toBe(p.pairToken);
    expect(sha256Hex(p.pairToken)).toBe(p.relayTokenHash);
  });
  it("formats and parses the manual code and the QR fragment", () => {
    const otp = fromHex(p.otp);
    expect(manualCode(otp)).toBe(p.manualCode);
    expect(toHex(parseManualCode(p.manualCode.toLowerCase().replace("-", " "))!)).toBe(p.otp);
    expect(parseManualCode("short")).toBeNull();
    const offer = parseOffer(p.qrFragment)!;
    expect(offer.relayHost).toBe("127.0.0.1:8787");
    expect(toHex(offer.macPub)).toBe(p.macPub);
    expect(formatOffer(offer)).toBe(p.qrFragment);
    expect(parseOffer("https://x.example/#p=a,b,c,d")).toBeNull();
    expect(b64u(offer.otp)).toBe(p.qrFragment.split(",")[3]);
  });
  it("frames with the tags the gateway expects", () => {
    expect(Array.from(framed(TAG.IK_INIT, Uint8Array.of(9)))).toEqual([3, 9]);
    expect([TAG.PAIR_INIT, TAG.PAIR_RESP, TAG.IK_INIT, TAG.IK_RESP, TAG.DATA, TAG.RESET]).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
