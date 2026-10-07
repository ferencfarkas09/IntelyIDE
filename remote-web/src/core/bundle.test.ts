// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { BLOCKING, bundleInfo, isOk, resetBundleInfo, seqDate } from "./bundle";
import { baseFiles, KEY_A, KEY_B, makeSite } from "../sw/testkit";

const netFor = (m: ReturnType<typeof makeSite>) =>
  (async (input: RequestInfo | URL) => {
    const p = new URL(String(input), "https://r.test").pathname.slice(1);
    const b = m.site.get(p);
    return b ? new Response(b.slice()) : new Response("", { status: 404 });
  }) as typeof fetch;
const pin = (pub: string, maxSeq = 0) => ({ bundlePub: pub, maxSeq, relayHost: "r.test" });

beforeEach(resetBundleInfo);

describe("bundleInfo", () => {
  it("okSigned under the pinned key", async () => {
    const m = makeSite(baseFiles(), { seq: 1_790_000_000 });
    const b = await bundleInfo(netFor(m), pin(KEY_A.pub));
    expect(b.state).toBe("okSigned");
    expect(b.hash).toBe(m.hash);
    expect(b.signerFingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
    expect(seqDate(b.seq)?.getUTCFullYear()).toBe(2026);
  });
  it("okHashOnly without a pin", async () => {
    expect((await bundleInfo(netFor(makeSite(baseFiles(), { seq: 5 })), null)).state).toBe("okHashOnly");
  });
  it("keyChanged when another key signed it", async () => {
    const b = await bundleInfo(netFor(makeSite(baseFiles(), { seq: 5, key: KEY_B })), pin(KEY_A.pub));
    expect(b.state).toBe("keyChanged");
    expect(BLOCKING.has(b.state)).toBe(true);
  });
  it("badSignature when the seq was changed after signing", async () => {
    const b = await bundleInfo(netFor(makeSite(baseFiles(), { seq: 5, mutate: (m) => void (m.seq = 6) })), pin(KEY_A.pub));
    expect(b.state).toBe("badSignature");
  });
  it("rollback when older than the highest accepted seq", async () => {
    const b = await bundleInfo(netFor(makeSite(baseFiles(), { seq: 5 })), pin(KEY_A.pub, 9));
    expect(b.state).toBe("rollback");
    expect(isOk(b.state)).toBe(false);
  });
  it("mismatch when a served file differs (not a blocking state)", async () => {
    const m = makeSite(baseFiles(), { seq: 5 });
    m.site.set("assets/app.js", new TextEncoder().encode("evil"));
    const b = await bundleInfo(netFor(m), pin(KEY_A.pub));
    expect(b.state).toBe("mismatch");
    expect(b.detail).toContain("assets/app.js");
  });
  it("missing when there is no manifest or the network is down", async () => {
    expect((await bundleInfo((async () => new Response("", { status: 404 })) as typeof fetch, null)).state).toBe("missing");
    resetBundleInfo();
    expect((await bundleInfo((async () => Promise.reject(new TypeError("offline"))) as typeof fetch, null)).state).toBe("missing");
    expect(BLOCKING.has("missing")).toBe(false);
  });
});
