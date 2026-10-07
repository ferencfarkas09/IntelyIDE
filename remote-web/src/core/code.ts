// The pairing payloads the Mac shows (crates/remote/src/pairing.rs): the QR fragment and the grouped manual code.
import { b64u, fromB64u } from "../noise/bytes";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 128 bits -> 26 Crockford base32 characters grouped by 5 (`XXXXX-XXXXX-...-X`). */
export function manualCode(otp: Uint8Array): string {
  let acc = 0;
  let bits = 0;
  let out = "";
  for (const b of otp) {
    acc = ((acc << 8) | b) >>> 0;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(acc << (5 - bits)) & 31];
  return out.match(/.{1,5}/g)!.join("-");
}

/** Accepts the grouped code in any case, with O/I/L typos fixed; `null` when it is not 128 bits. */
export function parseManualCode(code: string): Uint8Array | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const raw of code) {
    if (raw === "-" || /\s/.test(raw)) continue;
    let c = raw.toUpperCase();
    if (c === "O") c = "0";
    else if (c === "I" || c === "L") c = "1";
    const v = CROCKFORD.indexOf(c);
    if (v < 0) return null;
    acc = ((acc << 5) | v) >>> 0;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 255);
      bits -= 8;
      acc &= (1 << bits) - 1;
    }
  }
  return out.length >= 16 ? Uint8Array.from(out.slice(0, 16)) : null;
}

export interface Offer {
  relayHost: string;
  roomId: string;
  macPub: Uint8Array;
  otp: Uint8Array;
}

/** `#p=<relayHost>,<roomId>,<macStaticPub>,<otp>` (the QR payload; also accepted as a whole link or with the leading `#`).
 *  Exactly 4 fields: the build-signing key is NOT in the QR, it arrives inside the Noise channel (`welcome`). With `expectHost`
 *  (the page's `location.host`) an offer for another relay is refused. */
export function parseOffer(text: string, expectHost?: string): Offer | null {
  const m = /p=([^&\s]+)/.exec(text.trim());
  if (!m) return null;
  const parts = decodeURIComponent(m[1]!).split(",");
  if (parts.length !== 4) return null;
  try {
    const [relayHost, roomId, pub, otp] = parts as [string, string, string, string];
    const macPub = fromB64u(pub);
    const otpBytes = fromB64u(otp);
    if (macPub.length !== 32 || otpBytes.length !== 16 || !/^[A-Za-z0-9_-]{22,64}$/.test(roomId) || !/^[A-Za-z0-9.:\[\]-]+$/.test(relayHost)) return null;
    if (expectHost !== undefined && relayHost !== expectHost) return null;
    return { relayHost, roomId, macPub, otp: otpBytes };
  } catch {
    return null;
  }
}

export const formatOffer = (o: Offer): string => `#p=${o.relayHost},${o.roomId},${b64u(o.macPub)},${b64u(o.otp)}`;
