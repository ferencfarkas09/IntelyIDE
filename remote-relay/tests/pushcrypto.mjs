// Receiver side of RFC 8291 / RFC 8292, written independently of src/push.ts so the two can check each other.
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";

export function makeSubscriber(endpoint) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, sub: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } } };
}

export function decryptPush(subscriber, body) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPub = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const uaPub = subscriber.ecdh.getPublicKey();
  const secret = subscriber.ecdh.computeSecret(asPub);
  const ikm = Buffer.from(hkdfSync("sha256", secret, subscriber.auth, Buffer.concat([Buffer.from("WebPush: info\0"), uaPub, asPub]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12));
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end--;
  if (plain[end - 1] !== 2) throw new Error("bad padding delimiter");
  return plain.subarray(0, end - 1);
}

/** Verify `vapid t=<jwt>, k=<pub>`; returns claims. */
export function verifyVapid(header, expectAud) {
  const m = header.match(/^vapid t=([^,]+), k=(\S+)$/);
  if (!m) throw new Error("bad vapid header");
  const [h, c, s] = m[1].split(".");
  const pub = Buffer.from(m[2], "base64url");
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
  const ok = verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  if (!ok) throw new Error("bad vapid signature");
  const claims = JSON.parse(Buffer.from(c, "base64url").toString());
  if (claims.aud !== expectAud) throw new Error("aud " + claims.aud);
  return { claims, alg: JSON.parse(Buffer.from(h, "base64url").toString()).alg, pub: m[2] };
}
