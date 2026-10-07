// Pairing (remote-plan 2.4, S0): Noise_IKpsk2 over a `pair.<token>` relay socket, then the 6-digit comparison, then the Mac user
// decides. The phone learns the outcome (device id + token, capability) only inside the channel.
import { Handshake, TAG, framed, generateKeyPair, pairTokenFromOtp, pskFromOtp } from "../noise/noise";
import { b64u } from "../noise/bytes";
import { RelaySocket, wsBase, type WsCtor } from "./relay";
import type { Offer } from "./code";
import type { DeviceRecord } from "./storage";
import { decodePairReply, encode } from "./wire";

export type PairStep = "connecting" | "handshake" | "compare" | "waiting";

export class PairError extends Error {
  constructor(
    readonly code: "macOffline" | "expired" | "mismatch" | "rejected" | "timeout" | "network" | "relay",
    message: string,
  ) {
    super(message);
  }
}

export interface PairHooks {
  onStep(step: PairStep): void;
  /** The six digits to compare with the Mac. */
  onSas(code: string): void;
  /** The Mac's build-signing public key (raw Ed25519, base64url), received inside the Noise channel before `accepted`. */
  onWelcome?(bundlePub: string): void;
}

export interface PairOptions {
  offer: Offer;
  deviceName: string;
  bundleHash: string | null;
  hooks: PairHooks;
  base?: string;
  wsCtor?: WsCtor;
  /** How long the Mac user has to compare and decide (the Mac allows 120 s). */
  decideMs?: number;
  signal?: AbortSignal;
}

export function pair(o: PairOptions): Promise<DeviceRecord> {
  const { offer } = o;
  const key = generateKeyPair();
  const hs = new Handshake({ kind: "pairing", initiator: true, s: key, rs: offer.macPub, psk: pskFromOtp(offer.otp) });
  const base = o.base ?? wsBase();
  let transport: ReturnType<Handshake["toTransport"]> | null = null;

  return new Promise<DeviceRecord>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const done = (err: PairError | null, rec?: DeviceRecord) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.close();
      err ? reject(err) : resolve(rec!);
    };
    o.hooks.onStep("connecting");
    const sock = new RelaySocket(
      `${base}/r/${offer.roomId}/ws`,
      `pair.${pairTokenFromOtp(offer.otp)}`,
      {
        onControl(c) {
          if (c.t === "hello") {
            if (c.mac !== "online") return done(new PairError("macOffline", "The Mac is offline. Open IntelyIDE on the Mac and try again."));
            o.hooks.onStep("handshake");
            sock.sendFrame(framed(TAG.PAIR_INIT, hs.write()));
          } else if (c.t === "err" && c.code === "macOffline") done(new PairError("macOffline", "The Mac is offline. Open IntelyIDE on the Mac and try again."));
          else if (c.t === "err") done(new PairError("relay", `The relay refused: ${String(c.code)}`));
        },
        onFrame(bytes) {
          try {
            const tag = bytes[0];
            const body = bytes.subarray(1);
            if (tag === TAG.PAIR_RESP && !transport) {
              hs.read(body);
              transport = hs.toTransport();
              o.hooks.onSas(hs.sas());
              o.hooks.onStep("compare");
              sock.sendFrame(framed(TAG.DATA, transport.encrypt(encode({ t: "hello", name: o.deviceName }))));
              o.hooks.onStep("waiting");
            } else if (tag === TAG.DATA && transport) {
              const reply = decodePairReply(transport.decrypt(body));
              if (!reply) return;
              if (reply.t === "welcome") return o.hooks.onWelcome?.(reply.bundlePub);
              if (reply.t === "rejected") return done(new PairError("rejected", reply.reason));
              done(null, {
                relayHost: new URL(base.replace(/^ws/, "http")).host,
                roomId: offer.roomId,
                macPub: b64u(offer.macPub),
                phonePriv: b64u(key.priv),
                deviceId: reply.deviceId,
                deviceToken: reply.deviceToken,
                macName: reply.macName,
                name: o.deviceName,
                capability: reply.capability,
                pairedAt: Date.now(),
                bundleHash: o.bundleHash,
              });
            }
          } catch {
            done(new PairError("mismatch", "The pairing code did not match this Mac. Start again from the Mac."));
          }
        },
        onClose(code) {
          done(new PairError(code === 1006 ? "expired" : "network", code === 1006 ? "The code is expired or was already used. Start again on the Mac." : "The connection closed during pairing."));
        },
      },
      o.wsCtor,
    );
    timer = setTimeout(() => done(new PairError("timeout", "The Mac did not answer in time.")), o.decideMs ?? 150_000);
    o.signal?.addEventListener("abort", () => done(new PairError("network", "Cancelled.")));
  });
}
