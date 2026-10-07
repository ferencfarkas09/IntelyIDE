// Pure logic of the preview module: the loopback URL gate, device presets, zoom and the environment label.
// Nothing here touches the DOM, the Ipc or a timer.
import { t, type MessageKey } from "../../i18n";

/** The only hosts a preview frame may load. Mirrors the single `frame-src` line in `src-tauri/tauri.conf.json` (`[::1]` is not in it, so it is refused). */
export const LOOPBACK_HOSTS = ["localhost", "127.0.0.1"] as const;
/** The `frame-src` sources the CSP carries. A test fails when the config differs. */
export const FRAME_SRC = ["http://127.0.0.1:*", "http://localhost:*"] as const;
/** The sandbox of the preview iframe. No top navigation, no downloads, no escaping popups; a test pins this string. */
export const FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-modals";
/** Ports of the IDE's own dev server: a frame on the app's origin would share its Tauri IPC. */
export const IDE_PORTS: readonly number[] = [1420];

export type UrlRejection = "empty" | "tooLong" | "badChars" | "scheme" | "credentials" | "notLoopback" | "badPort" | "selfOrigin";

export type UrlCheck =
  | { ok: true; url: string; host: string; port: number; origin: string }
  | { ok: false; reason: UrlRejection; message: string };

const MESSAGE_KEY = {
  empty: "pv.url.empty",
  tooLong: "pv.url.tooLong",
  badChars: "pv.url.badChars",
  scheme: "pv.url.scheme",
  credentials: "pv.url.credentials",
  notLoopback: "pv.url.notLoopback",
  badPort: "pv.url.badPort",
  selfOrigin: "pv.url.selfOrigin",
} as const satisfies Record<UrlRejection, MessageKey>;

const AUTHORITY = /^(localhost|127\.0\.0\.1)(?::(\d+))?$/i;

/**
 * The URL gate. Strict on purpose: it matches the raw text against the three literal loopback hosts, so no alternative
 * IP spelling (`127.1`, `2130706433`, `0x7f.1`), no `*.localhost`, no `127.0.0.1.nip.io` and no hostname that "resolves to
 * loopback" gets through (DNS rebinding). The returned `url` is normalised and is what the frame loads.
 * `selfOrigin` is the page's own origin (the IDE); the frame may never be on it.
 */
export function validatePreviewUrl(input: string, selfOrigin?: string): UrlCheck {
  const fail = (reason: UrlRejection): UrlCheck => ({ ok: false, reason, message: t(MESSAGE_KEY[reason]) });
  let s = input.trim();
  if (!s) return fail("empty");
  if (s.length > 2048) return fail("tooLong");
  if (/[\s\u0000-\u001f\u007f\\]/.test(s)) return fail("badChars");
  // Shorthands: `8082`, `:8082`, `localhost:8082/x`, `127.0.0.1`.
  if (/^\d{2,5}$/.test(s)) s = `http://localhost:${s}`;
  else if (/^:\d{1,5}(?:[/?#]|$)/.test(s)) s = `http://localhost${s}`;
  else if (/^(localhost|127\.0\.0\.1)(?:[:/?#]|$)/i.test(s)) s = `http://${s}`;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (scheme && scheme[1].toLowerCase() !== "http") return fail("scheme");
  if (!scheme) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^/?#]*:\d+(?:[/?#]|$)/.test(s)) return fail("scheme"); // file:, javascript:, data:, mailto:
    s = `http://${s}`;
  }
  const m = /^http:\/\/([^/?#]*)([/?#].*)?$/i.exec(s);
  if (!m) return fail("notLoopback");
  const [, authority, rest = ""] = m;
  if (authority.includes("@")) return fail("credentials");
  // eslint-disable-next-line no-control-regex
  if (/[^\x21-\x7e]/.test(authority)) return fail("badChars");
  const a = AUTHORITY.exec(authority);
  if (!a) return /^(localhost|127\.0\.0\.1):/i.test(authority) ? fail("badPort") : fail("notLoopback");
  const host = a[1].toLowerCase();
  const port = a[2] === undefined ? 80 : Number(a[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || (a[2] !== undefined && a[2].length > 5)) return fail("badPort");
  if (IDE_PORTS.includes(port)) return fail("selfOrigin");
  if (selfOrigin) {
    try {
      const own = new URL(selfOrigin);
      if ((LOOPBACK_HOSTS as readonly string[]).includes(own.hostname) && own.port && Number(own.port) === port) return fail("selfOrigin");
    } catch {
      // an opaque origin ("null", tauri://): nothing to compare against
    }
  }
  const origin = `http://${host}${port === 80 ? "" : `:${port}`}`;
  const url = `${origin}${rest.startsWith("/") ? rest : `/${rest}`}`;
  // The browser's parser must agree with ours, or the string is not trusted.
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" || u.username || u.password || !(LOOPBACK_HOSTS as readonly string[]).includes(u.hostname)) return fail("notLoopback");
  } catch {
    return fail("notLoopback");
  }
  return { ok: true, url, host, port, origin };
}

/** Same gate for a route the quick-list produced: joins the server origin and a path. */
export function routeUrl(origin: string, route: string): string {
  return `${origin.replace(/\/+$/, "")}/${route.replace(/^\/+/, "")}`;
}

/** Appends `__ide_reload=<n>` for a hard reload; the dev servers ignore it. */
export function withCacheBust(url: string, n: number): string {
  const [base, hash = ""] = url.split(/#(.*)/s, 2);
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}__ide_reload=${n}${hash ? `#${hash}` : ""}`;
}

/** The frame address through the click-to-source proxy: the proxy's origin with the page's own path, query and hash. */
export function viaProxy(url: string, proxyUrl: string): string {
  try {
    const page = new URL(url);
    return `${new URL(proxyUrl).origin}${page.pathname}${page.search}${page.hash}`;
  } catch {
    return url;
  }
}

// --- devices -----------------------------------------------------------------------------------------------------

export interface Device {
  id: string;
  name: string;
  /** CSS pixels in portrait; `fluid` fills the pane. */
  width: number;
  height: number;
  kind: "phone" | "tablet" | "desktop" | "fluid" | "custom";
}

export const DEVICES: readonly Device[] = [
  { id: "fluid", name: "Fit to pane", width: 0, height: 0, kind: "fluid" },
  { id: "iphone-se", name: "iPhone SE", width: 375, height: 667, kind: "phone" },
  { id: "iphone-15", name: "iPhone 15", width: 393, height: 852, kind: "phone" },
  { id: "iphone-15-pro-max", name: "iPhone 15 Pro Max", width: 430, height: 932, kind: "phone" },
  { id: "ipad-mini", name: "iPad mini", width: 744, height: 1133, kind: "tablet" },
  { id: "ipad-pro-11", name: "iPad Pro 11\"", width: 834, height: 1194, kind: "tablet" },
  { id: "laptop", name: "Laptop 1280", width: 1280, height: 800, kind: "desktop" },
  { id: "desktop", name: "Desktop 1440", width: 1440, height: 900, kind: "desktop" },
  { id: "desktop-fhd", name: "Full HD 1920", width: 1920, height: 1080, kind: "desktop" },
  { id: "custom", name: "Custom size", width: 800, height: 600, kind: "custom" },
];

/** The label of a preset: the two generic ones are translated, the rest are product names. */
export const deviceName = (d: Device): string => (d.kind === "fluid" ? t("pv.device.fluid") : d.kind === "custom" ? t("pv.device.custom") : d.name);

export const deviceById = (id: string): Device => DEVICES.find((d) => d.id === id) ?? DEVICES[0];

export const MIN_SIZE = 200;
export const MAX_SIZE = 4000;
export const clampSize = (n: number): number => (Number.isFinite(n) ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(n))) : MIN_SIZE);

/** The frame's CSS size for a device in its natural orientation (phones and tablets portrait, desktops landscape); `rotated` swaps the two. */
export function frameSize(device: Device, rotated: boolean, custom?: { width: number; height: number }): { width: number; height: number } | null {
  if (device.kind === "fluid") return null;
  const base = device.kind === "custom" && custom ? { width: clampSize(custom.width), height: clampSize(custom.height) } : { width: device.width, height: device.height };
  return rotated ? { width: base.height, height: base.width } : base;
}

export const ZOOMS = [0.5, 0.75, 1, 1.25] as const;
export type Zoom = "fit" | (typeof ZOOMS)[number];

/** Scale that makes a `w` x `h` frame fit a pane (never above 1 when fitting). */
export function fitScale(w: number, h: number, paneW: number, paneH: number, pad = 24): number {
  if (w <= 0 || h <= 0 || paneW <= 0 || paneH <= 0) return 1;
  return Math.max(0.1, Math.min(1, (paneW - pad) / w, (paneH - pad) / h));
}

export const scaleFor = (zoom: Zoom, size: { width: number; height: number } | null, pane: { width: number; height: number }): number =>
  !size ? 1 : zoom === "fit" ? fitScale(size.width, size.height, pane.width, pane.height) : zoom;

// --- environment label -------------------------------------------------------------------------------------------

export const ENVS = ["unset", "local", "sandbox", "staging", "production"] as const;
export type Env = (typeof ENVS)[number];

/** The IDE cannot read which API the admin app picked (the user chooses it inside the app), so the user says it here. */
const ENV_KEY = { unset: "pv.env.unset", local: "pv.env.local", sandbox: "pv.env.sandbox", staging: "pv.env.staging", production: "pv.env.production" } as const satisfies Record<Env, MessageKey>;
export const envLabel = (e: Env): string => t(ENV_KEY[e]);
export const ENV_TONE: Record<Env, "warn" | "neutral" | "ok" | "info" | "danger"> = { unset: "warn", local: "neutral", sandbox: "ok", staging: "info", production: "danger" };

export const isEnv = (v: unknown): v is Env => typeof v === "string" && (ENVS as readonly string[]).includes(v);

// --- persisted per-repo state ------------------------------------------------------------------------------------

export type Scheme = "dark" | "light";

export interface RepoState {
  /** Empty until the user (or a quick-list pick) sets one; the view falls back to the repo kind's default port. */
  url: string;
  device: string;
  rotated: boolean;
  zoom: Zoom;
  custom: { width: number; height: number };
  env: Env;
  /** Free text next to the environment, e.g. the sandbox host name. Never a credential. */
  envNote: string;
  /** Backdrop behind the frame; the framed page keeps following its own theme. */
  scheme: Scheme;
  /** Whether the quick-list is open. */
  list: boolean;
}

export const defaultRepoState = (): RepoState => ({ url: "", device: "fluid", rotated: false, zoom: "fit", custom: { width: 800, height: 600 }, env: "unset", envNote: "", scheme: "dark", list: true });

/** Reads whatever settings.json holds; anything malformed falls back field by field, a bad URL is dropped. */
export function parseRepoState(raw: unknown, selfOrigin?: string): RepoState {
  const d = defaultRepoState();
  if (typeof raw !== "object" || raw === null) return d;
  const r = raw as Record<string, unknown>;
  const url = typeof r.url === "string" && r.url ? validatePreviewUrl(r.url, selfOrigin) : null;
  const zoom = r.zoom === "fit" || (ZOOMS as readonly unknown[]).includes(r.zoom) ? (r.zoom as Zoom) : d.zoom;
  const custom = typeof r.custom === "object" && r.custom !== null ? (r.custom as Record<string, unknown>) : {};
  return {
    url: url?.ok ? url.url : "",
    device: typeof r.device === "string" && DEVICES.some((x) => x.id === r.device) ? r.device : d.device,
    rotated: r.rotated === true,
    zoom,
    custom: { width: clampSize(Number(custom.width ?? d.custom.width)), height: clampSize(Number(custom.height ?? d.custom.height)) },
    env: isEnv(r.env) ? r.env : d.env,
    envNote: typeof r.envNote === "string" ? r.envNote.slice(0, 80) : "",
    scheme: r.scheme === "light" ? "light" : "dark",
    list: r.list !== false,
  };
}
