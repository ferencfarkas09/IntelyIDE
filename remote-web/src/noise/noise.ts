// Noise over the relay (remote-plan 2.4), the phone side of crates/remote/src/noise.rs. One fixed suite, no negotiation:
// Noise_IKpsk2 for pairing and Noise_IK for reconnects, X25519 / ChaChaPoly / SHA-256, the prologue pins the protocol version.
// Written on the vetted @noble primitives; interop with `snow` is pinned by test/vectors/noise.json (produced by crates/remote).
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { b64u, concat, equalBytes, utf8 } from "./bytes";

export const SUITE_IK = "Noise_IK_25519_ChaChaPoly_SHA256";
export const SUITE_IKPSK2 = "Noise_IKpsk2_25519_ChaChaPoly_SHA256";
export const PROLOGUE = utf8("intely-remote\u0000v1\u0000min=1");
export const REKEY_EVERY = 65_536;
export const MAX_NOISE_MSG = 65_535;

/** Frame tags on a link (crates/remote/src/noise.rs `tag`). */
export const TAG = { PAIR_INIT: 1, PAIR_RESP: 2, IK_INIT: 3, IK_RESP: 4, DATA: 5, RESET: 6 } as const;

export const framed = (tag: number, body: Uint8Array): Uint8Array => concat(Uint8Array.of(tag), body);

export interface KeyPair {
  priv: Uint8Array;
  pub: Uint8Array;
}

export function generateKeyPair(): KeyPair {
  const priv = x25519.utils.randomSecretKey();
  return { priv, pub: x25519.getPublicKey(priv) };
}

export const keyPairFromPriv = (priv: Uint8Array): KeyPair => ({ priv, pub: x25519.getPublicKey(priv) });

const dh = (priv: Uint8Array, pub: Uint8Array): Uint8Array => {
  const out = x25519.getSharedSecret(priv, pub);
  if (out.every((b) => b === 0)) throw new Error("noise: low-order point");
  return out;
};

function nonce(n: bigint): Uint8Array {
  const out = new Uint8Array(12);
  new DataView(out.buffer).setBigUint64(4, n, true);
  return out;
}

/** HKDF of the Noise spec (HMAC-SHA256), `count` outputs of 32 bytes. */
function hkdf(ck: Uint8Array, ikm: Uint8Array, count: 2 | 3): Uint8Array[] {
  const temp = hmac(sha256, ck, ikm);
  const o1 = hmac(sha256, temp, Uint8Array.of(1));
  const o2 = hmac(sha256, temp, concat(o1, Uint8Array.of(2)));
  if (count === 2) return [o1, o2];
  return [o1, o2, hmac(sha256, temp, concat(o2, Uint8Array.of(3)))];
}

class CipherState {
  n = 0n;
  count = 0;
  constructor(public k: Uint8Array | null) {}

  encrypt(ad: Uint8Array, pt: Uint8Array): Uint8Array {
    if (!this.k) return pt;
    const ct = chacha20poly1305(this.k, nonce(this.n), ad).encrypt(pt);
    this.n++;
    return ct;
  }

  decrypt(ad: Uint8Array, ct: Uint8Array): Uint8Array {
    if (!this.k) return ct;
    const pt = chacha20poly1305(this.k, nonce(this.n), ad).decrypt(ct); // throws before n moves: state untouched on a bad frame
    this.n++;
    return pt;
  }

  /** Noise REKEY: the first 32 bytes of the encryption of 32 zero bytes at the maximum nonce. The counter keeps running. */
  rekey(): void {
    if (!this.k) return;
    this.k = chacha20poly1305(this.k, nonce(0xffff_ffff_ffff_ffffn), new Uint8Array(0)).encrypt(new Uint8Array(32)).slice(0, 32);
  }
}

export type Kind = "pairing" | "reconnect";

export interface HandshakeInit {
  kind: Kind;
  initiator: boolean;
  /** Own static key. */
  s: KeyPair;
  /** The Mac's static public key (initiator only; it is the pre-message). */
  rs?: Uint8Array;
  /** 32-byte PSK (pairing only). */
  psk?: Uint8Array;
  /** A fixed ephemeral secret: interop vectors only, never in the app. */
  fixedEphemeral?: Uint8Array;
}

export class Handshake {
  private ck: Uint8Array;
  private h: Uint8Array;
  private cs = new CipherState(null);
  private e: KeyPair | null = null;
  private re: Uint8Array | null = null;
  private rs: Uint8Array | null;
  private step = 0;
  private done = false;
  private final: Uint8Array | null = null;
  private readonly usesPsk: boolean;

  constructor(private readonly o: HandshakeInit) {
    const name = utf8(o.kind === "pairing" ? SUITE_IKPSK2 : SUITE_IK);
    this.usesPsk = o.kind === "pairing";
    if (this.usesPsk && o.psk?.length !== 32) throw new Error("noise: pairing needs a 32-byte psk");
    this.h = name.length <= 32 ? concat(name, new Uint8Array(32 - name.length)) : sha256(name);
    this.ck = this.h;
    this.mixHash(PROLOGUE);
    this.rs = o.initiator ? (o.rs ?? null) : null;
    if (o.initiator && !this.rs) throw new Error("noise: the initiator needs the Mac's static key");
    // pre-message "<- s": the responder's static key
    this.mixHash(o.initiator ? this.rs! : o.s.pub);
  }

  private mixHash(d: Uint8Array): void {
    this.h = sha256(concat(this.h, d));
  }

  private mixKey(ikm: Uint8Array): void {
    const [ck, k] = hkdf(this.ck, ikm, 2);
    this.ck = ck!;
    this.cs = new CipherState(k!);
  }

  private mixKeyAndHash(ikm: Uint8Array): void {
    const [ck, th, k] = hkdf(this.ck, ikm, 3);
    this.ck = ck!;
    this.mixHash(th!);
    this.cs = new CipherState(k!);
  }

  private encryptAndHash(pt: Uint8Array): Uint8Array {
    const ct = this.cs.encrypt(this.h, pt);
    this.mixHash(ct);
    return ct;
  }

  private decryptAndHash(ct: Uint8Array): Uint8Array {
    const pt = this.cs.decrypt(this.h, ct);
    this.mixHash(ct);
    return pt;
  }

  private newEphemeral(): KeyPair {
    return this.o.fixedEphemeral ? keyPairFromPriv(this.o.fixedEphemeral) : generateKeyPair();
  }

  private sendE(): Uint8Array {
    this.e = this.newEphemeral();
    this.mixHash(this.e.pub);
    if (this.usesPsk) this.mixKey(this.e.pub);
    return this.e.pub;
  }

  private recvE(msg: Uint8Array): void {
    this.re = msg.slice(0, 32);
    this.mixHash(this.re);
    if (this.usesPsk) this.mixKey(this.re);
  }

  /** Writes the next handshake message (initiator: message 1, responder: message 2). */
  write(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    if (this.done) throw new Error("noise: handshake finished");
    if (this.o.initiator && this.step === 0) {
      const e = this.sendE();
      this.mixKey(dh(this.e!.priv, this.rs!)); // es
      const s = this.encryptAndHash(this.o.s.pub);
      this.mixKey(dh(this.o.s.priv, this.rs!)); // ss
      const body = this.encryptAndHash(payload);
      this.step = 1;
      return concat(e, s, body);
    }
    if (!this.o.initiator && this.step === 1) {
      const e = this.sendE();
      this.mixKey(dh(this.e!.priv, this.re!)); // ee
      this.mixKey(dh(this.e!.priv, this.rs!)); // se
      if (this.usesPsk) this.mixKeyAndHash(this.o.psk!);
      const body = this.encryptAndHash(payload);
      this.finish();
      return concat(e, body);
    }
    throw new Error("noise: not our turn to write");
  }

  /** Reads the peer's message; returns its decrypted payload. Throws on any authentication failure. */
  read(msg: Uint8Array): Uint8Array {
    if (this.done) throw new Error("noise: handshake finished");
    if (msg.length > MAX_NOISE_MSG) throw new Error("noise: message too long");
    if (!this.o.initiator && this.step === 0) {
      if (msg.length < 32 + 48 + 16) throw new Error("noise: short message");
      this.recvE(msg);
      this.mixKey(dh(this.o.s.priv, this.re!)); // es
      this.rs = this.decryptAndHash(msg.slice(32, 32 + 48));
      this.mixKey(dh(this.o.s.priv, this.rs)); // ss
      const pt = this.decryptAndHash(msg.slice(32 + 48));
      this.step = 1;
      return pt;
    }
    if (this.o.initiator && this.step === 1) {
      if (msg.length < 32 + 16) throw new Error("noise: short message");
      this.recvE(msg);
      this.mixKey(dh(this.e!.priv, this.re!)); // ee
      this.mixKey(dh(this.o.s.priv, this.re!)); // se
      if (this.usesPsk) this.mixKeyAndHash(this.o.psk!);
      const pt = this.decryptAndHash(msg.slice(32));
      this.finish();
      return pt;
    }
    throw new Error("noise: not our turn to read");
  }

  private finish(): void {
    this.done = true;
    this.final = this.h;
  }

  get isFinished(): boolean {
    return this.done;
  }

  /** The peer's static key, once known (the responder learns it from message 1). */
  get remoteStatic(): Uint8Array | null {
    return this.rs;
  }

  get handshakeHash(): Uint8Array {
    if (!this.final) throw new Error("noise: handshake not finished");
    return this.final;
  }

  /** The 6 digits both screens show, derived from the handshake hash. */
  sas(): string {
    const h = sha256(concat(utf8("intely-remote/sas/v1"), this.handshakeHash));
    return String(new DataView(h.buffer, h.byteOffset).getUint32(0) % 1_000_000).padStart(6, "0");
  }

  toTransport(): Transport {
    if (!this.done) throw new Error("noise: handshake not finished");
    const [k1, k2] = hkdf(this.ck, new Uint8Array(0), 2);
    return this.o.initiator ? new Transport(new CipherState(k1!), new CipherState(k2!)) : new Transport(new CipherState(k2!), new CipherState(k1!));
  }
}

/** Counter-based AEAD stream per direction; each direction rekeys every REKEY_EVERY messages. */
export class Transport {
  constructor(
    private readonly out: CipherState,
    private readonly inn: CipherState,
  ) {}

  encrypt(pt: Uint8Array): Uint8Array {
    if (pt.length + 16 > MAX_NOISE_MSG) throw new Error("noise: plaintext too long");
    const ct = this.out.encrypt(new Uint8Array(0), pt);
    if (++this.out.count % REKEY_EVERY === 0) this.out.rekey();
    return ct;
  }

  /** A frame that does not authenticate (garbage, replay, reorder, wrong session) throws and leaves the state untouched. */
  decrypt(ct: Uint8Array): Uint8Array {
    if (ct.length < 16 || ct.length > MAX_NOISE_MSG) throw new Error("noise: bad frame length");
    const pt = this.inn.decrypt(new Uint8Array(0), ct);
    if (++this.inn.count % REKEY_EVERY === 0) this.inn.rekey();
    return pt;
  }

  get counters(): { sent: number; received: number } {
    return { sent: this.out.count, received: this.inn.count };
  }
}

// ---------------------------------------------------------------- pairing helpers (crates/remote/src/{noise,pairing}.rs)

/** The 32-byte PSK of a pairing from its 128-bit one-time code. */
export const pskFromOtp = (otp: Uint8Array): Uint8Array => sha256(concat(utf8("intely-remote/pair-psk/v1"), otp));

/** The relay credential `pair.<token>` of a pairing, derived from the same code. */
export const pairTokenFromOtp = (otp: Uint8Array): string => b64u(sha256(concat(utf8("intely-remote/pair-token/v1"), otp)));

export const sha256Hex = (data: Uint8Array | string): string =>
  Array.from(sha256(typeof data === "string" ? utf8(data) : data), (b) => b.toString(16).padStart(2, "0")).join("");

export { equalBytes };
