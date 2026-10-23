export type RegistrationState = "unasked" | "registered" | "declined";

export interface RegistryStatus {
  state: RegistrationState;
  name: string | null;
  email: string | null;
  /** `none`, `pending`, `subscribed`, `unsubscribed` or `failed`, as the registry last said. */
  newsletter: string | null;
  /** The version (a date) of the notice this build shows, and the one the person agreed to. */
  notice: string;
  consentedNotice: string | null;
  /** The first-start screen is due: never asked, or registered under an older notice. */
  needsConsent: boolean;
  /** The registry the data goes to. */
  url: string;
}

export interface RegisterInput {
  name: string;
  email: string;
  newsletter: boolean;
  consent: boolean;
  locale: string;
  tz: string;
}

export interface RegistryProblem {
  code: string;
  message: string;
  retryAfterSeconds?: number;
}

/** What the registry says it stores (`GET /v1/me`). */
export interface StoredData {
  notice: string;
  user: { name: string; email: string; consentNotice: string; consentAt: number; newsletter: string };
  computer: {
    os: string;
    os_version: string;
    arch: string;
    cpu_cores: number;
    ram_gb: number;
    locale: string;
    tz: string;
    app_version: string;
    country: string | null;
    region: string | null;
    city: string | null;
    first_seen: number;
    last_seen: number;
    launches: number;
  } | null;
  computers: number;
}
