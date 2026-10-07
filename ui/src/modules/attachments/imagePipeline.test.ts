import { describe, expect, it } from "vitest";
import { fitWithin, hasExif, ImageError, jpegOrientation, processImage, stripJpegMetadata, stripPngMetadata, type Decoded, type ImageDeps } from "./imagePipeline";

const bytes = (...parts: (number[] | string)[]) => new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));
const seg = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];

/** A tiny JPEG skeleton: SOI, JFIF, EXIF (little endian, orientation 6, a GPS pointer), XMP, COM, SOS + data, EOI. */
function jpeg(orientation: number): Uint8Array {
  const tiff = [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, /* 2 entries */ 2, 0, /* orientation */ 0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, /* GPS ifd pointer */ 0x25, 0x88, 4, 0, 1, 0, 0, 0, 0x40, 0, 0, 0, 0, 0, 0, 0];
  return bytes([0xff, 0xd8], seg(0xe0, [...bytes("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]), seg(0xe1, [...bytes("Exif\0\0"), ...tiff]), seg(0xe1, [...bytes("http://ns.adobe.com/xap/1.0/\0"), 60]), seg(0xfe, [...bytes("shot at home")]), [0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]);
}

function png(): Uint8Array {
  const chunk = (type: string, data: number[]) => [0, 0, 0, data.length, ...bytes(type), ...data, 0, 0, 0, 0];
  return bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], chunk("IHDR", new Array(13).fill(0)), chunk("eXIf", [1, 2, 3]), chunk("tEXt", [...bytes("GPS\0here")]), chunk("IDAT", [9, 9]), chunk("IEND", []));
}

describe("fitWithin", () => {
  it("leaves small images alone and scales the longest side to 1568", () => {
    expect(fitWithin(800, 600, 1568)).toEqual({ width: 800, height: 600, scaled: false });
    expect(fitWithin(3136, 1568, 1568)).toEqual({ width: 1568, height: 784, scaled: true });
    expect(fitWithin(1000, 4000, 1568)).toEqual({ width: 392, height: 1568, scaled: true });
  });
});

describe("metadata strippers", () => {
  it("reads the EXIF orientation of a JPEG", () => {
    expect(jpegOrientation(jpeg(6))).toBe(6);
    expect(jpegOrientation(jpeg(1))).toBe(1);
    expect(jpegOrientation(png())).toBe(1);
  });
  it("removes EXIF (with GPS), XMP and comments from a JPEG but keeps JFIF and the image data", () => {
    const src = jpeg(1);
    expect(hasExif(src)).toBe(true);
    const out = stripJpegMetadata(src);
    expect(hasExif(out)).toBe(false);
    expect(new TextDecoder().decode(out)).not.toContain("shot at home");
    expect(new TextDecoder("latin1").decode(out)).toContain("JFIF");
    expect([...out.slice(-9)]).toEqual([0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]);
    expect(out.length).toBeLessThan(src.length);
  });
  it("removes eXIf and text chunks from a PNG and keeps the pixel chunks", () => {
    const out = stripPngMetadata(png());
    const s = new TextDecoder("latin1").decode(out);
    expect(s).not.toContain("eXIf");
    expect(s).not.toContain("tEXt");
    expect(s).toContain("IDAT");
    expect(s).toContain("IEND");
  });
  it("returns anything that is not a JPEG / PNG untouched", () => {
    const junk = bytes("hello");
    expect(stripJpegMetadata(junk)).toBe(junk);
    expect(stripPngMetadata(junk)).toBe(junk);
  });
});

function deps(size: (w: number, h: number, mime: string, q: number) => number, dims: { width: number; height: number } | null, log: { w: number; h: number; q: number; mime: string }[] = []): ImageDeps {
  return {
    decode: async () => (dims ? ({ ...dims } as Decoded) : null),
    encode: async (_s, w, h, mime, q) => {
      log.push({ w, h, q, mime });
      return new Blob([new Uint8Array(size(w, h, mime, q))], { type: mime });
    },
  };
}

describe("processImage", () => {
  it("passes a small upright JPEG through with its metadata stripped (no re-encode)", async () => {
    const src = new Blob([jpeg(1) as BlobPart], { type: "image/jpeg" });
    const log: never[] = [];
    const out = await processImage(src, "a.jpg", deps(() => 1, { width: 800, height: 600 }, log));
    expect(out).toMatchObject({ reencoded: false, stripped: true, resized: false, mime: "image/jpeg" });
    expect(hasExif(new Uint8Array(await out.blob.arrayBuffer()))).toBe(false);
    expect(log).toHaveLength(0);
  });
  it("re-encodes a rotated JPEG so the orientation is applied and EXIF dropped", async () => {
    const log: { w: number }[] = [];
    const out = await processImage(new Blob([jpeg(6) as BlobPart], { type: "image/jpeg" }), "r.jpg", deps(() => 100, { width: 800, height: 600 }, log as never));
    expect(out.reencoded).toBe(true);
    expect(log.length).toBe(1);
  });
  it("resizes to at most 1568 px on the longest side", async () => {
    const log: { w: number; h: number }[] = [];
    const out = await processImage(new Blob([new Uint8Array(10)], { type: "image/png" }), "big.png", deps(() => 1000, { width: 4000, height: 3000 }, log as never));
    expect(log[0]).toMatchObject({ w: 1568, h: 1176 });
    expect(out).toMatchObject({ resized: true, width: 1568, height: 1176, note: "resized to 1568×1176" });
  });
  it("lowers the quality, then the size, until the result is at most 5 MB", async () => {
    const log: { q: number; w: number; mime: string }[] = [];
    // size shrinks with quality and area: 6.5 MB at q 0.9 / 1568 px
    const size = (w: number, _h: number, _m: string, q: number) => Math.round(6.5 * 1024 * 1024 * (q / 0.9) * (w / 1568) ** 2);
    const out = await processImage(new Blob([new Uint8Array(20)], { type: "image/jpeg" }), "p.jpg", deps(size, { width: 3000, height: 2000 }, log as never));
    expect(out.blob.size).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(log.length).toBeGreaterThan(1);
    expect(log[0].q).toBe(0.9);
    expect(Math.min(...log.map((l) => l.q))).toBeGreaterThanOrEqual(0.5);
  });
  it("turns a PNG that stays huge into a JPEG", async () => {
    const log: { mime: string }[] = [];
    const size = (_w: number, _h: number, mime: string) => (mime === "image/png" ? 9 * 1024 * 1024 : 400 * 1024);
    const out = await processImage(new Blob([new Uint8Array(20)], { type: "image/png" }), "shot.png", deps(size, { width: 2000, height: 1000 }, log as never));
    expect(out.mime).toBe("image/jpeg");
    expect(out.name).toBe("shot.jpg");
  });
  it("refuses a format the WebView cannot decode, and an image that cannot get under the cap", async () => {
    await expect(processImage(new Blob([new Uint8Array(4)], { type: "image/heic" }), "a.heic", deps(() => 1, null))).rejects.toMatchObject({ code: "unsupported" });
    await expect(processImage(new Blob([new Uint8Array(4)], { type: "image/jpeg" }), "x.jpg", deps(() => 9 * 1024 * 1024, { width: 3000, height: 3000 }))).rejects.toBeInstanceOf(ImageError);
  });
});
