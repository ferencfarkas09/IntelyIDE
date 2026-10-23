export interface Env {
  DB: D1Database;
  // secrets
  ADMIN_TOKEN?: string;
  PEPPER?: string;
  BREVO_API_KEY?: string;
  // vars
  NOTICE_VERSION?: string;
  RETENTION_DAYS?: string;
  NEWSLETTER_PROVIDER?: string;
  BREVO_LIST_ID?: string;
  BREVO_DOI_TEMPLATE_ID?: string;
  NEWSLETTER_REDIRECT_URL?: string;
}

/** What the app tells about the computer. The id is a hash made in the app, never a hardware id. */
export interface Device {
  id: string;
  os: "macos" | "windows" | "linux" | "other";
  osVersion: string;
  arch: "aarch64" | "x86_64" | "other";
  cpuCores: number;
  ramGb: number;
  locale: string;
  tz: string;
}

export interface RegisterInput {
  name: string;
  email: string;
  newsletter: boolean;
  notice: string;
  appVersion: string;
  device: Device;
}

/** The part of a ping that may change from start to start (the id comes from the token). */
export type DeviceUpdate = Omit<Device, "id">;

export interface PingInput {
  appVersion: string;
  device: DeviceUpdate;
}

export type NewsletterStatus = "none" | "pending" | "subscribed" | "unsubscribed" | "failed";

export interface Place {
  country: string | null;
  region: string | null;
  city: string | null;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
