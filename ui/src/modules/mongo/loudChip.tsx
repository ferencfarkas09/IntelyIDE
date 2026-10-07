// Loudness of production connections: the persistent bar, the TLS chips, the writer banner, the title-bar chip and the
// first-connect confirmation. Everything says it in words and an icon as well as colour (spec 4/F6, 12/T12).
import { createSignal, For, Show, type JSX } from "solid-js";
import { t } from "../../i18n";
import type { ProfileView, RoleChip } from "../../ipc/mongo";
import { Badge, Button, Dialog, Lock, ShieldAlert, TriangleAlert } from "../../ui-kit";
import { isDangerous, roleView } from "./logic";
import { profiles } from "./store";
import { studioSnapshot } from "./gate";
import "./loud.css";

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)$/i;
const hostOnly = (h: string) => h.replace(/^\[|\](:\d+)?$/g, "").replace(/:\d+$/, "").replace(/ \(srv\)$/, "");

export type LoudProfile = Pick<ProfileView, "environment" | "effectiveLevel" | "host" | "tlsRelax" | "spec" | "name">;

export interface Loudness {
  /** Production tag or production-level (non-loopback, +srv, tunnel). */
  production: boolean;
  /** Why it is production: the tag, or the host rule. */
  reason: "tag" | "host" | "tunnel" | undefined;
  /** TLS is off and at least one host is not on this machine. */
  plainTls: boolean;
  /** Certificate checks are skipped. */
  relaxed: boolean;
  tls: "on" | "off" | "auto" | "relaxed";
}

/** All the loud facts of one profile, derived from non-secret fields only. */
export function loudness(p: LoudProfile): Loudness {
  const production = isDangerous(p);
  const tunnel = p.spec?.tunnel?.kind === "ssh" || p.spec?.tunnel?.kind === "socks5";
  const mode = p.spec?.tls?.mode ?? "auto";
  const hosts = p.spec?.hosts?.length ? p.spec.hosts.map((h) => h.host) : [hostOnly(p.host)];
  const remote = tunnel || hosts.some((h) => h && !LOOPBACK.test(h));
  const relaxed = p.tlsRelax === "certificates";
  return {
    production,
    reason: !production ? undefined : p.environment === "production" ? "tag" : tunnel ? "tunnel" : "host",
    plainTls: mode === "off" && remote,
    relaxed,
    tls: relaxed ? "relaxed" : mode,
  };
}

/** "PRODUCTION . read-only . host": persistent and not dismissable, at the top of every production collection tab and card. */
export function ProductionBar(props: { profile: LoudProfile; class?: string }) {
  const l = () => loudness(props.profile);
  const why = () => (l().reason === "tag" ? t("mongoLoud.bar.reasonTag") : l().reason === "tunnel" ? t("mongoLoud.bar.reasonTunnel") : t("mongoLoud.bar.reasonHost"));
  return (
    <Show when={l().production}>
      <div class={props.class ? `ld-bar ${props.class}` : "ld-bar"} role="status" aria-label={t("mongoLoud.bar.aria", { host: props.profile.host })} title={why()} data-loud="production">
        <ShieldAlert size={14} aria-hidden="true" />
        <strong class="ld-bar__word">{t("mongoLoud.bar.production")}</strong>
        <span aria-hidden="true">·</span>
        <span class="ld-bar__ro"><Lock size={12} aria-hidden="true" /> {t("mongoLoud.bar.readOnly")}</span>
        <span aria-hidden="true">·</span>
        <span class="ld-bar__host ui-mono ui-truncate" dir="ltr">{props.profile.host}</span>
      </div>
    </Show>
  );
}

/** Plain TLS to a remote host and relaxed certificate checks: warning chips with a sentence behind them. */
export function TlsChips(props: { profile: LoudProfile; size?: "sm" | "md" }) {
  const l = () => loudness(props.profile);
  return (
    <>
      <Show when={l().plainTls}>
        <Badge size={props.size ?? "sm"} tone="danger" icon={TriangleAlert} title={t("mongoLoud.chip.plainTls.title")}>{t("mongoLoud.chip.plainTls.label")}</Badge>
      </Show>
      <Show when={l().relaxed}>
        <Badge size={props.size ?? "sm"} tone="warn" icon={TriangleAlert} title={t("mongoLoud.chip.relaxed.title")}>{t("mongoLoud.chip.relaxed.label")}</Badge>
      </Show>
    </>
  );
}

/** The role probe found write privileges (or no sign-in at all): said in words, above everything else. */
export function WriterBanner(props: { role: RoleChip | undefined }) {
  const writer = () => (props.role?.role === "canWrite" ? props.role : undefined);
  return (
    <Show when={writer()}>
      {(w) => (
        <div class="ld-writer" role="alert" data-loud="writer">
          <TriangleAlert size={14} aria-hidden="true" />
          <span><strong>{w().noAuth ? t("mongoLoud.writer.noAuthTitle") : t("mongoLoud.writer.title")}</strong> {roleView(props.role).detail}</span>
        </div>
      )}
    </Show>
  );
}

/** Title-bar / status-bar chip while at least one production connection is open. Nothing at all otherwise. */
export function LoudChip(props: { onClick?: () => void }) {
  const open = () => {
    const ids = new Set((studioSnapshot()?.connections ?? []).map((c) => c.id));
    return profiles().filter((p) => ids.has(p.id) && isDangerous(p));
  };
  const label = () => t("mongoLoud.titleChip.count", { n: open().length });
  const body = (): JSX.Element => (
    <>
      <ShieldAlert size={12} aria-hidden="true" />
      <span>{t("mongoLoud.bar.production")}</span>
    </>
  );
  return (
    <Show when={open().length > 0}>
      <Show when={props.onClick} fallback={<span class="ld-chip" role="status" aria-label={label()} title={label()} data-loud="chip">{body()}</span>}>
        <button type="button" class="ld-chip" aria-label={label()} title={label()} data-loud="chip" onClick={props.onClick}>{body()}</button>
      </Show>
    </Show>
  );
}

// --- first connect to production in this app session --------------------------------------------------------------------
const confirmed = new Set<string>();
/** Forget every confirmation (switch off, tests). */
export const resetProductionConfirms = () => confirmed.clear();
export const needsProductionConfirm = (p: Pick<ProfileView, "id" | "environment" | "effectiveLevel">) => isDangerous(p) && !confirmed.has(p.id);

/**
 * `guard(profile)` resolves true when the connect may go ahead: at once for a non-production profile or one already
 * confirmed this session, else after the user answers the dialog. The default button is Cancel (not a typed confirmation).
 * Render `dialog()` once next to the component that calls it.
 */
export function createProductionGate() {
  const [pending, setPending] = createSignal<{ p: ProfileView; done: (ok: boolean) => void }>();
  const guard = (p: ProfileView): Promise<boolean> => {
    if (!needsProductionConfirm(p)) return Promise.resolve(true);
    pending()?.done(false);
    return new Promise<boolean>((resolve) => setPending({ p, done: resolve }));
  };
  const answer = (ok: boolean) => {
    const cur = pending();
    if (!cur) return;
    setPending(undefined);
    if (ok) confirmed.add(cur.p.id);
    cur.done(ok);
  };
  const dialog = () => (
    <Show when={pending()}>{(cur) => <ProductionConfirm profile={cur().p} onAnswer={answer} />}</Show>
  );
  return { guard, dialog };
}

export function ProductionConfirm(props: { profile: ProfileView; onAnswer: (ok: boolean) => void }) {
  const l = () => loudness(props.profile);
  const tlsText = () => t(l().tls === "relaxed" ? "mongoLoud.confirm.tls.relaxed" : l().tls === "off" ? "mongoLoud.confirm.tls.off" : l().tls === "on" ? "mongoLoud.confirm.tls.on" : "mongoLoud.confirm.tls.auto");
  const rows = (): [string, string][] => [
    [t("mongoLoud.confirm.host"), props.profile.host],
    [t("mongoLoud.confirm.access"), t("mongoLoud.confirm.readOnly")],
    [t("mongoLoud.confirm.security"), tlsText()],
  ];
  return (
    <Dialog
      open
      size="sm"
      role="alertdialog"
      closeOnBackdrop={false}
      onClose={() => props.onAnswer(false)}
      title={t("mongoLoud.confirm.title", { name: props.profile.name })}
      description={t("mongoLoud.confirm.body")}
      footer={
        <>
          <Button variant="secondary" data-autofocus onClick={() => props.onAnswer(false)}>{t("mongoLoud.confirm.cancel")}</Button>
          <Button variant="danger" onClick={() => props.onAnswer(true)}>{t("mongoLoud.confirm.connect")}</Button>
        </>
      }
    >
      <ProductionBar profile={props.profile} class="ld-bar--in-dialog" />
      <dl class="ld-facts">
        <For each={rows()}>{([k, v]) => <><dt>{k}</dt><dd class="ui-mono" dir="auto">{v}</dd></>}</For>
      </dl>
      <div class="ld-facts__chips"><TlsChips profile={props.profile} /></div>
    </Dialog>
  );
}
