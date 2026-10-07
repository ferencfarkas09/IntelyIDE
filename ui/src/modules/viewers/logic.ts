// Pure helpers of the viewers module: which viewer a file gets, sizes, base64.

export type DataKind = "json" | "jsonl" | "log";
export type PreviewKind = "markdown" | "svg" | "image" | "pdf";

/** The 50 MB cap of the data viewers (JSON must be parsed whole; logs and JSONL show the first 50 MB). */
export const MAX_DATA_BYTES = 50 * 1024 * 1024;
/** Images are decoded by the webview; anything larger is offered in the system viewer instead. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const CHUNK_BYTES = 4 * 1024 * 1024;

const ext = (path: string): string => {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

export function dataKindOf(path: string): DataKind | null {
  switch (ext(path)) {
    case "json":
    case "geojson":
    case "webmanifest":
      return "json";
    case "jsonl":
    case "ndjson":
      return "jsonl";
    case "log":
      return "log";
    default:
      return null;
  }
}

export function previewKindOf(path: string): PreviewKind | null {
  switch (ext(path)) {
    case "md":
    case "markdown":
    case "mdx":
      return "markdown";
    case "svg":
      return "svg";
    case "png":
    case "jpg":
    case "jpeg":
    case "webp":
    case "gif":
      return "image";
    case "pdf":
      return "pdf";
    default:
      return null;
  }
}

export const IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml" };
export const mimeOf = (path: string): string => IMAGE_MIME[ext(path)] ?? "application/octet-stream";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export const fileName = (path: string): string => path.split("/").pop() ?? path;
