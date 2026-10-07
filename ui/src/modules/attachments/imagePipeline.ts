// Image pipeline: every image is shrunk to at most 1568 px on the longest side, stripped of EXIF/GPS and capped at
import { t } from "../../i18n";
// 5 MB BEFORE it reaches the store or a provider. Codec access is injected (`ImageDeps`) so the planning, the
// metadata strippers and the 5 MB loop are unit-testable without a canvas.
import { FILE_LIMITS } from "./types";

export interface Decoded {
  width: number;
  height: number;
  close?(): void;
}

export interface ImageDeps {
  /** Decodes any format the WebView can (HEIC on WKWebView via createImageBitmap); null = unsupported. */
  decode(blob: Blob): Promise<Decoded | null>;
  encode(src: Decoded, width: number, height: number, mime: "image/jpeg" | "image/png", quality: number, source: Blob): Promise<Blob>;
}

export interface ProcessedImage {
  blob: Blob;
  name: string;
  mime: string;
  width: number;
  height: number;
  resized: boolean;
  reencoded: boolean;
  /** EXIF, GPS, XMP, IPTC and text chunks are gone. */
  stripped: boolean;
  note?: string;
}

export class ImageError extends Error {
  constructor(readonly code: "unsupported" | "tooLarge", message: string) {
    super(message);
  }
}

export function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number; scaled: boolean } {
  const longest = Math.max(width, height);
  if (longest <= maxSide) return { width, height, scaled: false };
  const k = maxSide / longest;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), scaled: true };
}

// ---- metadata strippers (lossless) -------------------------------------------------------------------------------

/** EXIF orientation (1..8) of a JPEG, or 1 when absent. */
export function jpegOrientation(b: Uint8Array): number {
  if (b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let i = 2;
  while (i + 4 < b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    if (marker === 0xda) break;
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78) {
      const t = i + 10; // TIFF header after "Exif\0\0"
      const le = b[t] === 0x49;
      const u16 = (o: number) => (le ? b[t + o] | (b[t + o + 1] << 8) : (b[t + o] << 8) | b[t + o + 1]);
      const u32 = (o: number) => (le ? (b[t + o] | (b[t + o + 1] << 8) | (b[t + o + 2] << 16) | (b[t + o + 3] << 24)) >>> 0 : ((b[t + o] << 24) | (b[t + o + 1] << 16) | (b[t + o + 2] << 8) | b[t + o + 3]) >>> 0);
      const ifd = u32(4);
      const n = u16(ifd);
      for (let k = 0; k < n; k++) {
        const e = ifd + 2 + k * 12;
        if (u16(e) === 0x0112) return u16(e + 8) || 1;
      }
      return 1;
    }
    i += 2 + len;
  }
  return 1;
}

/** Drops APP1 (EXIF, XMP), APP12/13 (Photoshop, IPTC), APP14 and COM segments of a JPEG; keeps JFIF and the ICC profile. */
export function stripJpegMetadata(b: Uint8Array): Uint8Array {
  if (b[0] !== 0xff || b[1] !== 0xd8) return b;
  const drop = new Set([0xe1, 0xec, 0xed, 0xee, 0xfe]);
  let i = 2;
  const keep: [number, number][] = [[0, 2]];
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    if (marker === 0xda) break; // start of scan: the rest is image data
    const len = (b[i + 2] << 8) | b[i + 3];
    if (!drop.has(marker)) keep.push([i, i + 2 + len]);
    i += 2 + len;
  }
  keep.push([i, b.length]);
  const total = keep.reduce((n, [s, e]) => n + (e - s), 0);
  const res = new Uint8Array(total);
  let o = 0;
  for (const [s, e] of keep) (res.set(b.subarray(s, e), o), (o += e - s));
  return res;
}

/** Drops eXIf, tEXt, zTXt, iTXt and tIME chunks of a PNG. */
export function stripPngMetadata(b: Uint8Array): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (sig.some((v, k) => b[k] !== v)) return b;
  const drop = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);
  const keep: [number, number][] = [[0, 8]];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    const end = i + 12 + len;
    if (!drop.has(type)) keep.push([i, Math.min(end, b.length)]);
    i = end;
  }
  const total = keep.reduce((n, [s, e]) => n + (e - s), 0);
  const res = new Uint8Array(total);
  let o = 0;
  for (const [s, e] of keep) (res.set(b.subarray(s, e), o), (o += e - s));
  return res;
}

/** Whether a byte string still carries an EXIF block or a GPS tag (used by tests and as a last check). */
export function hasExif(b: Uint8Array): boolean {
  const s = new TextDecoder("latin1").decode(b.subarray(0, Math.min(b.length, 256 * 1024)));
  return s.includes("Exif\0\0") || s.includes("eXIf") || s.includes("http://ns.adobe.com/xap");
}

// ---- pipeline ----------------------------------------------------------------------------------------------------

const PASS = new Set(["image/jpeg", "image/png"]);
const extFor = (mime: string) => (mime === "image/png" ? "png" : "jpg");
const stem = (name: string) => name.replace(/\.[^./\\]+$/, "") || "image";

export async function processImage(input: Blob, name: string, deps: ImageDeps, limits: { maxSide: number; maxBytes: number } = { maxSide: FILE_LIMITS.imageMaxSide, maxBytes: FILE_LIMITS.imageBytes }): Promise<ProcessedImage> {
  const mime = (input.type || "").toLowerCase();
  const decoded = await deps.decode(input);
  if (!decoded) throw new ImageError("unsupported", mime ? t("attach.img.unsupported", { mime }) : t("attach.img.unsupportedGeneric"));
  try {
    const fit = fitWithin(decoded.width, decoded.height, limits.maxSide);
    // Lossless path: a JPEG or PNG that already fits, with upright orientation, only loses its metadata.
    if (PASS.has(mime) && !fit.scaled && input.size <= limits.maxBytes) {
      const bytes = new Uint8Array(await input.arrayBuffer());
      if (mime === "image/png" || jpegOrientation(bytes) <= 1) {
        const clean = mime === "image/png" ? stripPngMetadata(bytes) : stripJpegMetadata(bytes);
        return { blob: new Blob([clean as BlobPart], { type: mime }), name, mime, width: decoded.width, height: decoded.height, resized: false, reencoded: false, stripped: true };
      }
    }
    // Re-encode through the canvas: applies orientation, drops every metadata block, enforces both caps.
    const outMime = mime === "image/png" && input.size < limits.maxBytes * 4 ? "image/png" : "image/jpeg";
    let { width, height } = fit;
    let quality = 0.9;
    let blob = await deps.encode(decoded, width, height, outMime, quality, input);
    let guard = 0;
    while (blob.size > limits.maxBytes && guard++ < 24) {
      if (outMime === "image/jpeg" && quality > 0.55) quality = Math.round((quality - 0.1) * 100) / 100;
      else {
        width = Math.max(1, Math.round(width * 0.8));
        height = Math.max(1, Math.round(height * 0.8));
        if (Math.max(width, height) < 160) throw new ImageError("tooLarge", t("attach.img.tooLarge"));
      }
      // A PNG that is still too big becomes a JPEG: the photo case.
      blob = await deps.encode(decoded, width, height, outMime === "image/png" && guard > 2 ? "image/jpeg" : outMime, quality, input);
    }
    if (blob.size > limits.maxBytes) throw new ImageError("tooLarge", t("attach.img.tooLarge"));
    const finalMime = blob.type === "image/png" ? "image/png" : "image/jpeg";
    const note = fit.scaled ? t("attach.img.resized", { width: String(fit.width), height: String(fit.height) }) : undefined;
    return { blob, name: `${stem(name)}.${extFor(finalMime)}`, mime: finalMime, width, height, resized: fit.scaled || width !== fit.width, reencoded: true, stripped: true, note };
  } finally {
    decoded.close?.();
  }
}

/** The WebView implementation: createImageBitmap + canvas. HEIC decodes where WKWebView supports it, else `decode` returns null. */
export const browserImageDeps: ImageDeps = {
  async decode(blob) {
    try {
      return await createImageBitmap(blob);
    } catch {
      return null;
    }
  },
  async encode(src, width, height, mime, quality) {
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    if (mime === "image/jpeg") {
      ctx.fillStyle = "#fff"; // JPEG has no alpha
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(src as unknown as CanvasImageSource, 0, 0, width, height);
    if ("convertToBlob" in canvas) return canvas.convertToBlob({ type: mime, quality });
    return new Promise<Blob>((resolve, reject) => (canvas as HTMLCanvasElement).toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), mime, quality));
  },
};
