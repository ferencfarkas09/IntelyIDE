// Pure logic of the component preview: props JSON validation, saved prop sets, the strict parser for what the harness page
// posts, viewport presets. Nothing here touches the DOM, the Ipc or a timer.

export const PROTOCOL = {
  ready: "preview/ready/1",
  status: "preview/status/1",
  event: "preview/event/1",
  shot: "preview/shot/1",
  set: "preview/set/1",
  shotReq: "preview/shot.req/1",
  hello: "preview/hello/1",
} as const;

export const MAX_JSON_BYTES = 200_000;
export const MAX_PRESETS = 30;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface Viewport {
  id: "fit" | "phone" | "tablet" | "desktop";
  /** CSS pixels; 0 means "fill the pane". */
  width: number;
  height: number;
}
export const VIEWPORTS: readonly Viewport[] = [
  { id: "fit", width: 0, height: 0 },
  { id: "phone", width: 393, height: 852 },
  { id: "tablet", width: 820, height: 1180 },
  { id: "desktop", width: 1280, height: 800 },
];
export const viewportById = (id: string): Viewport => VIEWPORTS.find((v) => v.id === id) ?? VIEWPORTS[0];

export type JsonCheck = { ok: true; value: Record<string, unknown> } | { ok: false; reason: "tooLarge" | "syntax" | "notObject" | "forbiddenKey"; line: number; col: number; detail: string };

function position(text: string, message: string): { line: number; col: number } {
  const lc = /line (\d+) column (\d+)/.exec(message);
  if (lc) return { line: Number(lc[1]), col: Number(lc[2]) };
  const pos = /position (\d+)/.exec(message);
  let at = pos ? Number(pos[1]) : -1;
  if (at < 0) {
    // `Unexpected token '}', ..."nClick": }" is not valid JSON`: find the snippet in the text, the token is its last character
    const snip = /^Unexpected token '(.)', (?:\.\.\.)?"([\s\S]*)"(?:\.\.\.)? is not valid JSON/.exec(message);
    if (snip) {
      const i = text.indexOf(snip[2]);
      if (i >= 0) at = i + Math.max(0, snip[2].lastIndexOf(snip[1]));
    }
  }
  if (at < 0) return { line: 1, col: 1 };
  const lines = text.slice(0, at).split("\n");
  return { line: lines.length, col: lines.at(-1)!.length + 1 };
}

function hasForbiddenKey(v: unknown, depth = 0): string | undefined {
  if (!v || typeof v !== "object" || depth > 40) return undefined;
  for (const k of Object.keys(v)) {
    if (FORBIDDEN_KEYS.has(k)) return k;
    const inner = hasForbiddenKey((v as Record<string, unknown>)[k], depth + 1);
    if (inner) return inner;
  }
  return undefined;
}

/** Parses the props (or store) editor text: a JSON object, bounded, without prototype-poisoning keys. Empty text is `{}`. */
export function parseJsonObject(text: string): JsonCheck {
  if (text.length > MAX_JSON_BYTES) return { ok: false, reason: "tooLarge", line: 1, col: 1, detail: "" };
  if (!text.trim()) return { ok: true, value: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: "syntax", ...position(text, message), detail: message.replace(/^JSON\.parse: /, "").slice(0, 160) };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "notObject", line: 1, col: 1, detail: "" };
  const bad = hasForbiddenKey(value);
  if (bad) return { ok: false, reason: "forbiddenKey", line: 1, col: 1, detail: bad };
  return { ok: true, value: value as Record<string, unknown> };
}

export const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

// --- wrappers, prefs, presets -------------------------------------------------------------------------------------

export interface Wrappers {
  theme: boolean;
  redux: boolean;
  router: boolean;
}
export const NO_WRAPPERS: Wrappers = { theme: false, redux: false, router: false };

export interface Preset {
  name: string;
  props: string;
  store: string;
}

export interface ComponentPrefs {
  /** Text of the props editor. `undefined`: never edited, the suggestion is used. */
  props?: string;
  store?: string;
  /** `undefined`: follow what the harness says the component uses. */
  wrappers?: Wrappers;
  scheme: "dark" | "light";
  viewport: Viewport["id"];
  layout: "padded" | "full";
  route: string;
  presets: Preset[];
}

export const defaultPrefs = (): ComponentPrefs => ({ scheme: "dark", viewport: "fit", layout: "padded", route: "/", presets: [] });

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length <= max ? v : undefined);

/** Reads a saved value from settings.json: anything unexpected falls back to the default, nothing throws. */
export function parsePrefs(raw: unknown): ComponentPrefs {
  const out = defaultPrefs();
  if (!raw || typeof raw !== "object") return out;
  const o = raw as Record<string, unknown>;
  const props = str(o.props, MAX_JSON_BYTES);
  const store = str(o.store, MAX_JSON_BYTES);
  if (props !== undefined) out.props = props;
  if (store !== undefined) out.store = store;
  const w = o.wrappers as Record<string, unknown> | undefined;
  if (w && typeof w === "object") out.wrappers = { theme: w.theme === true, redux: w.redux === true, router: w.router === true };
  if (o.scheme === "light" || o.scheme === "dark") out.scheme = o.scheme;
  if (typeof o.viewport === "string" && VIEWPORTS.some((v) => v.id === o.viewport)) out.viewport = o.viewport as Viewport["id"];
  if (o.layout === "full" || o.layout === "padded") out.layout = o.layout;
  const route = str(o.route, 200);
  if (route?.startsWith("/")) out.route = route;
  if (Array.isArray(o.presets)) {
    for (const p of o.presets.slice(0, MAX_PRESETS)) {
      const q = p as Record<string, unknown>;
      const name = str(q?.name, 60)?.trim();
      const pr = str(q?.props, MAX_JSON_BYTES);
      if (name && pr !== undefined && !out.presets.some((x) => x.name === name)) out.presets.push({ name, props: pr, store: str(q.store, MAX_JSON_BYTES) ?? "" });
    }
  }
  return out;
}

export const prefsKey = (repoId: string, path: string, exportName: string): string => `component:${repoId}:${path}#${exportName}`;

/** Adds or replaces a preset by name; at most MAX_PRESETS (the oldest goes). */
export function withPreset(list: readonly Preset[], preset: Preset): Preset[] {
  const name = preset.name.trim().slice(0, 60);
  if (!name) return [...list];
  const next = list.filter((p) => p.name !== name);
  next.push({ ...preset, name });
  return next.slice(-MAX_PRESETS);
}

// --- what the harness page posts ----------------------------------------------------------------------------------

export interface BuildError {
  file: string;
  line: number;
  col: number;
  text: string;
}
export type EventKind = "fn" | "dispatch" | "network" | "console" | "error";

export type FrameMessage =
  | { kind: "ready"; name: string; file: string; exports: string[]; available: { redux: boolean; mui: boolean; styled: boolean; router: boolean } }
  | { kind: "status"; state: "ok" | "renderError" | "runtimeError" | "buildError"; message: string; stack: string; componentStack: string; errors: BuildError[] }
  | { kind: "event"; event: EventKind; name: string; detail: string }
  | { kind: "shot"; id: string; ok: boolean; dataUrl: string; width: number; height: number; error: string };

const clip = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
// eslint-disable-next-line no-control-regex
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, "");
const IDENT = /^(default|[A-Za-z_$][\w$]{0,99})$/;
const MAX_DATA_URL = 12_000_000;
const EVENT_KINDS: readonly string[] = ["fn", "dispatch", "network", "console", "error"];

/** The page's messages are untrusted hints: strict shape, bounded, control and bidi characters removed. `undefined` = ignore. */
export function parseFrameMessage(data: unknown): FrameMessage | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const m = data as Record<string, unknown>;
  switch (m.intely) {
    case PROTOCOL.ready: {
      const exportsList = Array.isArray(m.exports) ? m.exports.filter((e): e is string => typeof e === "string" && IDENT.test(e)).slice(0, 60) : [];
      const a = (m.available ?? {}) as Record<string, unknown>;
      return { kind: "ready", name: clean(clip(m.name, 100)), file: clean(clip(m.file, 400)), exports: exportsList, available: { redux: a.redux === true, mui: a.mui === true, styled: a.styled === true, router: a.router === true } };
    }
    case PROTOCOL.status: {
      const state = m.state;
      if (state !== "ok" && state !== "renderError" && state !== "runtimeError" && state !== "buildError") return undefined;
      const errors = Array.isArray(m.errors)
        ? m.errors.slice(0, 20).map((e): BuildError => {
            const x = (e ?? {}) as Record<string, unknown>;
            return { file: clean(clip(x.file, 400)), line: Number.isInteger(x.line) ? Math.max(0, Math.min(10_000_000, x.line as number)) : 0, col: Number.isInteger(x.col) ? Math.max(0, Math.min(100_000, x.col as number)) : 0, text: clean(clip(x.text, 600)) };
          })
        : [];
      return { kind: "status", state, message: clean(clip(m.message, 600)), stack: clean(clip(m.stack, 3000)), componentStack: clean(clip(m.componentStack, 3000)), errors };
    }
    case PROTOCOL.event: {
      if (typeof m.kind !== "string" || !EVENT_KINDS.includes(m.kind)) return undefined;
      return { kind: "event", event: m.kind as EventKind, name: clean(clip(m.name, 300)), detail: clean(clip(m.detail, 300)) };
    }
    case PROTOCOL.shot: {
      const id = clip(m.id, 64);
      if (!id) return undefined;
      const ok = m.ok === true;
      const dataUrl = typeof m.dataUrl === "string" && m.dataUrl.length <= MAX_DATA_URL && m.dataUrl.startsWith("data:image/png;base64,") ? m.dataUrl : "";
      if (ok && !dataUrl) return undefined;
      return { kind: "shot", id, ok, dataUrl, width: Number.isInteger(m.width) ? (m.width as number) : 0, height: Number.isInteger(m.height) ? (m.height as number) : 0, error: clean(clip(m.error, 400)) };
    }
    default:
      return undefined;
  }
}

export function dataUrlToBytes(dataUrl: string): Uint8Array | undefined {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return undefined;
  try {
    const bin = atob(m[1]);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

/** The event log keeps the last N entries. */
export const EVENT_LIMIT = 200;
export function pushEvent<T>(list: readonly T[], item: T): T[] {
  const next = [...list, item];
  return next.length > EVENT_LIMIT ? next.slice(-EVENT_LIMIT) : next;
}
