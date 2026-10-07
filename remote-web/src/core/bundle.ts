// "Running bundle hash" (remote-plan 2.3, spec 4.6). The phone recomputes it from the files it was actually served: it reads the
// signed manifest of the RUNNING build (the service worker answers /bundle.json from the verified shell), checks the Ed25519
// signature against the key pinned at pairing, hashes every listed file, and only then shows the manifest hash. Without a pin
// (before the first pairing) only the hashes can be checked: `okHashOnly`, and the user's compare with the Mac is the root of trust.
import { badFiles, fingerprint, verifyManifest, type Manifest } from "./bundleVerify";
import { readPin, type PinRecord } from "./pin";

export type BundleState = "okSigned" | "okHashOnly" | "badSignature" | "keyChanged" | "rollback" | "mismatch" | "missing";

export interface BundleInfo {
  state: BundleState;
  /** Manifest hash, grouped for reading aloud with `groupHash`. */
  hash: string | null;
  files: number;
  /** Build sequence (seconds since the epoch for builds made by the IDE) and the fingerprint of the key that signed it. */
  seq: number | null;
  signerFingerprint: string | null;
  detail?: string;
}

/** The states in which the app must not open the Noise channel (the user sees a red banner and can reset the app). */
export const BLOCKING: ReadonlySet<BundleState> = new Set(["badSignature", "keyChanged", "rollback"]);
export const isOk = (s: BundleState): boolean => s === "okSigned" || s === "okHashOnly";

let cached: Promise<BundleInfo> | null = null;

export function bundleInfo(fetchFn: typeof fetch = fetch, pin?: PinRecord | null): Promise<BundleInfo> {
  return (cached ??= compute(fetchFn, pin));
}

export const resetBundleInfo = (): void => void (cached = null);

const DETAIL: Record<string, string> = {
  keyChanged: "This build is signed by a different key than the one your Mac gave this phone.",
  badSignature: "The signature of this build is not valid.",
  rollback: "This build is older than one this phone already accepted.",
  hashMismatch: "The file list does not match its hash.",
  format: "The build manifest is malformed.",
  v1Refused: "This build uses an old unsigned format.",
};

async function compute(f: typeof fetch, given?: PinRecord | null): Promise<BundleInfo> {
  const none = (detail: string): BundleInfo => ({ state: "missing", hash: null, files: 0, seq: null, signerFingerprint: null, detail });
  try {
    const r = await f("/bundle.json", { cache: "no-store" });
    if (!r.ok) return none("This build has no signed manifest.");
    const m = (await r.json()) as Manifest;
    const pin = given === undefined ? await readPin() : given;
    const v = verifyManifest(m, pin ? { bundlePub: pin.bundlePub, maxSeq: pin.maxSeq } : null);
    const hash = typeof m?.manifestSha256 === "string" ? m.manifestSha256 : null;
    if (!v.ok) {
      const state: BundleState = v.code === "keyMismatch" ? "keyChanged" : v.code === "badSignature" ? "badSignature" : v.code === "rollback" ? "rollback" : "mismatch";
      return { state, hash, files: Array.isArray(m?.files) ? m.files.length : 0, seq: typeof m?.seq === "number" ? m.seq : null, signerFingerprint: typeof m?.pubkey === "string" ? fingerprint(m.pubkey) || null : null, detail: DETAIL[v.code] ?? v.reason };
    }
    const bad = await badFiles(m, async (path) => {
      const res = await f("/" + path, { cache: "no-store" });
      return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
    });
    const files = m.files.length;
    const base = { hash: v.hash, files, seq: v.seq, signerFingerprint: fingerprint(v.pubkey) || null };
    if (bad.length) return { state: "mismatch", ...base, detail: `Files differ from the signed list: ${bad.slice(0, 3).join(", ")}` };
    return { state: v.signed ? "okSigned" : "okHashOnly", ...base };
  } catch (e) {
    return none((e as Error).message);
  }
}

export const groupHash = (h: string, n = 4): string => (h.match(new RegExp(`.{1,${n}}`, "g")) ?? []).join(" ");

/** Build time shown in Settings: IDE-made builds use the clock in seconds as `seq`; anything that is not a plausible time is hidden. */
export function seqDate(seq: number | null): Date | null {
  return seq !== null && seq > 1_000_000_000 && seq < 4_000_000_000 ? new Date(seq * 1000) : null;
}
