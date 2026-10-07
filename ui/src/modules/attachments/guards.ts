// Client mirror of crates/core/src/guard.rs (never-add / secret names) for the browser mock backend and for instant
// feedback. In the app the Rust store decides (`Meta.guard`); this must never be the only line of defence.
import type { GuardWarning } from "./types";
import { t } from "../../i18n";

const NEVER_ADD = ["dump_*", "SERVER_MOVE*", "_to_delete", "_check_*", "_tmp_*", "backup_*", ".history", "crm-export"];
const SECRET = [".env", ".env.*", "*.pfx", "google-services.json", "GoogleService-Info.plist", "google-service-account.json", "auth.json", "*.pem", "*.key", "*.p12", "*.p8", "*.jks", "*.keystore", "id_rsa*", "id_ed25519*", ".npmrc", ".netrc", "credentials.json", "serviceAccount*.json"];
const CRED_DIRS = [".ssh", ".aws", ".gnupg", ".kube"];

const re = (glob: string) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");
const NEVER_RE = NEVER_ADD.map(re);
const SECRET_RE = SECRET.map(re);

export function guardForPath(path: string): GuardWarning | null {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const name = parts[parts.length - 1] ?? "";
  const template = /^\.env\.(example|sample|template)$/i.test(name);
  if (!template && !/\.pub$/i.test(name) && SECRET_RE.some((r) => r.test(name))) return { reason: "secret", detail: t("attach.guard.secret") };
  if (parts.some((p) => NEVER_RE.some((r) => r.test(p)))) return { reason: "neverAdd", detail: t("attach.guard.neverAdd") };
  if (parts.some((p) => CRED_DIRS.includes(p.toLowerCase()))) return { reason: "neverRead", detail: t("attach.guard.neverRead") };
  return null;
}

export function guardForContent(text: string): GuardWarning | null {
  return /PRIVATE KEY-----|AWS_SECRET_ACCESS_KEY/.test(text.slice(0, 65536)) ? { reason: "key", detail: t("attach.guard.key") } : null;
}

export const guardText = (g: GuardWarning, provider: string): string => t("attach.guard.text", { detail: g.detail, provider });
