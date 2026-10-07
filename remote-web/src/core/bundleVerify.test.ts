import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { badFiles, fingerprint, verifyManifest, validPath, type PinView } from "./bundleVerify";

// Cross-implementation vectors made by remote-relay/scripts/bundle-lib.mjs (the reference). Every verdict must be identical here.
const V = JSON.parse(readFileSync(resolve(process.cwd(), "../remote-relay/tests/fixtures/bundle-v2/vectors.json"), "utf8")) as {
  keys: { A: { pub: string; fingerprint: string } };
  files: Record<string, string>;
  cases: { name: string; bundle: unknown; pin?: string; minSeq?: number; allowV1?: boolean; filesOverride?: Record<string, string | null>; expect: { ok: boolean; code?: string; hash?: string; seq?: number | null } }[];
};
const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));

describe("bundle v2 vectors (Node reference == phone)", () => {
  for (const c of V.cases.filter((x) => !x.filesOverride)) {
    it(c.name, () => {
      const pin: PinView | null = c.pin !== undefined ? { bundlePub: c.pin, maxSeq: c.minSeq } : null;
      const r = verifyManifest(c.bundle, pin, { allowV1: c.allowV1 });
      expect(r.ok).toBe(c.expect.ok);
      if (c.expect.ok && r.ok) {
        expect(r.hash).toBe(c.expect.hash);
        if (c.expect.seq !== undefined) expect(r.seq).toBe(c.expect.seq);
        expect(r.signed).toBe(!!pin);
      } else if (!r.ok) expect(r.code).toBe(c.expect.code);
    });
  }

  // The phone fetches only the files the manifest lists: a served-but-unlisted file cannot be seen here (the Mac audit covers that).
  for (const c of V.cases.filter((x) => x.filesOverride && x.name !== "served-file-added")) {
    it(c.name, async () => {
      const served = new Map(Object.entries({ ...V.files, ...c.filesOverride }).filter(([, v]) => v !== null) as [string, string][]);
      const m = c.bundle as { files: { path: string; sha256: string; size: number }[] };
      expect(verifyManifest(m, { bundlePub: V.keys.A.pub }).ok).toBe(true);
      const bad = await badFiles(m, async (p) => (served.has(p) ? b64(served.get(p)!) : null));
      expect(bad.length).toBeGreaterThan(0);
    });
  }

  it("serves the genuine files without a difference", async () => {
    const c = V.cases.find((x) => x.name === "valid")!;
    const m = c.bundle as { files: { path: string; sha256: string; size: number }[] };
    expect(await badFiles(m, async (p) => b64(V.files[p]!))).toEqual([]);
  });

  it("fingerprint equals the Node one", () => {
    expect(fingerprint(V.keys.A.pub)).toBe(V.keys.A.fingerprint);
  });

  it("path validator refuses hostile manifest paths", () => {
    for (const p of ["/evil.com/x", "../x", "a/../b", "a//b", "a/", "https://x/y", "a\\b", "", "a b"]) expect(validPath(p)).toBe(false);
    for (const p of ["index.html", "assets/app-1.js", "a/b/c.js"]) expect(validPath(p)).toBe(true);
  });
});
