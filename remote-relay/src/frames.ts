// Binary framing. The relay never looks past this header: everything after it is Noise ciphertext.
//   phone -> relay                : raw ciphertext (the relay knows which socket it came from)
//   relay -> phone                : raw ciphertext
//   Mac   -> relay                : [ver=1][idLen][deviceId][ciphertext]   (idLen 0 = every phone)
//   relay -> Mac                  : [ver=1][flags=0][qid u32 BE][idLen][deviceId][ciphertext]  (qid 0 = live, else queued: ack it)
const enc = new TextEncoder();
const dec = new TextDecoder();

export function parseMacFrame(buf: ArrayBuffer): { to: string | null; body: Uint8Array } | null {
  const b = new Uint8Array(buf);
  if (b.length < 2 || b[0] !== 1) return null;
  const n = b[1];
  if (b.length < 2 + n) return null;
  const to = n === 0 ? null : dec.decode(b.subarray(2, 2 + n));
  return { to, body: b.subarray(2 + n) };
}

export function buildMacFrame(from: string, qid: number, body: Uint8Array): Uint8Array {
  const id = enc.encode(from);
  const out = new Uint8Array(7 + id.length + body.length);
  out[0] = 1;
  out[1] = 0;
  new DataView(out.buffer).setUint32(2, qid >>> 0);
  out[6] = id.length;
  out.set(id, 7);
  out.set(body, 7 + id.length);
  return out;
}
