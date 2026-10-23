import type { Device, DeviceUpdate, Parsed, PingInput, RegisterInput } from "./types.ts";

export const MAX_BODY_BYTES = 4096;

const OS = ["macos", "windows", "linux"] as const;
const ARCH = ["aarch64", "x86_64"] as const;
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.normalize("NFC").trim();
  if (!t || t.length > max || CONTROL.test(t)) return null;
  return t;
}

function int(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export function parseEmail(v: unknown): string | null {
  const t = text(v, 254);
  if (!t) return null;
  const e = t.toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}$/i.test(e)) return null;
  return e;
}

export function parseVersion(v: unknown): string | null {
  const t = text(v, 40);
  return t && /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[0-9A-Za-z.-]{1,20})?$/.test(t) ? t : null;
}

/** A device update (everything but the id): unknown words for the operating system or the architecture become "other". */
export function parseDeviceUpdate(raw: unknown): Parsed<DeviceUpdate> {
  if (!isRecord(raw)) return fail("device");
  const osText = text(raw.os, 16)?.toLowerCase();
  const archText = text(raw.arch, 16)?.toLowerCase();
  const osVersion = text(raw.osVersion, 40);
  const locale = text(raw.locale, 35);
  const tz = text(raw.tz, 64);
  const cpuCores = int(raw.cpuCores, 1, 1024);
  const ramGb = int(raw.ramGb, 0, 4096);
  if (!osVersion || !/^[\w .+()-]+$/.test(osVersion)) return fail("device.osVersion");
  if (!locale || !/^[A-Za-z0-9_@.-]+$/.test(locale)) return fail("device.locale");
  if (!tz || !/^[A-Za-z0-9_/+-]+$/.test(tz)) return fail("device.tz");
  if (cpuCores === null) return fail("device.cpuCores");
  if (ramGb === null) return fail("device.ramGb");
  return {
    ok: true,
    value: {
      os: (OS as readonly string[]).includes(osText ?? "") ? (osText as Device["os"]) : "other",
      osVersion,
      arch: (ARCH as readonly string[]).includes(archText ?? "") ? (archText as Device["arch"]) : "other",
      cpuCores,
      ramGb,
      locale,
      tz,
    },
  };
}

export function parseRegister(raw: unknown): Parsed<RegisterInput> {
  if (!isRecord(raw)) return fail("body");
  const name = text(raw.name, 100);
  if (!name) return fail("name");
  const email = parseEmail(raw.email);
  if (!email) return fail("email");
  const consent = raw.consent;
  if (!isRecord(consent) || consent.storage !== true) return fail("consent");
  if (typeof consent.newsletter !== "boolean") return fail("consent.newsletter");
  const notice = text(consent.notice, 10);
  if (!notice || !/^\d{4}-\d{2}-\d{2}$/.test(notice)) return fail("consent.notice");
  const appVersion = parseVersion(raw.appVersion);
  if (!appVersion) return fail("appVersion");
  const device = raw.device;
  if (!isRecord(device)) return fail("device");
  const id = typeof device.id === "string" && /^[0-9a-f]{64}$/.test(device.id) ? device.id : null;
  if (!id) return fail("device.id");
  const rest = parseDeviceUpdate(device);
  if (!rest.ok) return rest;
  return { ok: true, value: { name, email, newsletter: consent.newsletter, notice, appVersion, device: { id, ...rest.value } } };
}

export function parsePing(raw: unknown): Parsed<PingInput> {
  if (!isRecord(raw)) return fail("body");
  const appVersion = parseVersion(raw.appVersion);
  if (!appVersion) return fail("appVersion");
  const device = parseDeviceUpdate(raw.device);
  if (!device.ok) return device;
  return { ok: true, value: { appVersion, device: device.value } };
}

/** A place name from Cloudflare, kept short and printable. */
export function place(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.normalize("NFC").trim();
  return t && t.length <= 64 && !CONTROL.test(t) ? t : null;
}

/** The first name, for the greeting of the confirmation mail: the first word of the name. */
export function firstName(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}
