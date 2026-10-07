import { t } from "../../i18n";
import type { HappyStatus, LastError, ProviderState, UserInfo } from "../../ipc/happy";
import type { Tone } from "../../ui-kit";

const chip = (state: ProviderState, tone: Tone) => ({
  get label() {
    return t(`integrations.state.${state}`);
  },
  tone,
});

/** The label is a getter, so a chip read at render time follows the language. */
export const STATE_CHIP: Record<ProviderState, { label: string; tone: Tone }> = {
  off: chip("off", "neutral"),
  waitingForToken: chip("waitingForToken", "warn"),
  probing: chip("probing", "info"),
  ready: chip("ready", "ok"),
  degraded: chip("degraded", "warn"),
  notPermitted: chip("notPermitted", "warn"),
  signedOut: chip("signedOut", "danger"),
  error: chip("error", "danger"),
};

export function ago(thenMs: number, nowMs: number): string {
  const min = Math.floor((nowMs - thenMs) / 60_000);
  if (min < 1) return t("integrations.ago.now");
  if (min < 60) return t("integrations.ago.min", { n: min });
  const h = Math.floor(min / 60);
  return h < 24 ? t("integrations.ago.h", { n: h }) : t("integrations.ago.d", { n: Math.floor(h / 24) });
}

export type ConnectionLine = { tone: Tone; text: string };

/** The one-line summary under the token field. */
export function connectionLine(status: HappyStatus | undefined, nowMs: number): ConnectionLine {
  if (!status) return { tone: "neutral", text: t("integrations.line.loading") };
  if (status.signedOut) return { tone: "danger", text: t("integrations.line.expired") };
  if (!status.tokenSaved) return { tone: "neutral", text: t("integrations.line.noToken") };
  const who = status.user ? t("integrations.connectedAs", { name: status.user.name }) : t("integrations.line.tokenSaved");
  const roles = status.user?.roles.length ? ` · ${status.user.roles.join(", ")}` : "";
  const when = status.validatedAtMs ? ` · ${t("integrations.line.checked", { when: ago(status.validatedAtMs, nowMs) })}` : "";
  return { tone: status.user ? "ok" : "neutral", text: `${who}${roles}${when}` };
}

/** The host a token will be sent to (shown before a custom URL is trusted). */
export function hostOf(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).host : undefined;
  } catch {
    return undefined;
  }
}

export const storeLabel = (u: UserInfo | null | undefined): string | undefined => u?.restaurantName ?? u?.restaurantId ?? undefined;

export const errorLine = (e: LastError | null | undefined): string | undefined => (e ? `${e.message} (${e.code})` : undefined);

/** A login token is three dot-separated parts without spaces; anything else is refused before it is sent. */
export const looksLikeToken = (draft: string): boolean => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(draft.trim());
