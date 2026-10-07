import { createSignal, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { errorText } from "../../store/snapshots";
import { Badge, Button, StatusDot, toast, type Tone } from "../../ui-kit";
import type { LaunchStatus, ProviderInfo } from "../../ipc/providers";
import { ConfirmLaunchDialog } from "./ConfirmLaunchDialog";
import { launchLine } from "./launch";

const TONE: Record<LaunchStatus, Tone> = { unconfirmed: "warn", confirmed: "ok", stale: "danger" };

/**
 * The command line an experimental provider runs: shown in full, confirmed once, stored with a hash. Loaded lazily, only for an
 * experimental provider that is switched on, so a Claude-only setup never fetches it.
 */
export default function LaunchPanel(props: { provider: ProviderInfo; onChange: (next: ProviderInfo) => void }) {
  const [open, setOpen] = createSignal(false);
  const l = () => props.provider.launch!;
  const line = () => (l().command ? launchLine(l()) : "");

  async function confirm(command: string, args: string[]) {
    try {
      props.onChange(await ipc.providers.confirmLaunch(props.provider.id, command, args));
      setOpen(false);
    } catch (e) {
      toast.error(t("providers.fail.title", { name: props.provider.name, what: t("providers.fail.confirm") }), errorText(e));
    }
  }

  async function revoke() {
    try {
      props.onChange(await ipc.providers.revokeLaunch(props.provider.id));
    } catch (e) {
      toast.error(t("providers.fail.title", { name: props.provider.name, what: t("providers.fail.revoke") }), errorText(e));
    }
  }

  return (
    <Show when={props.provider.launch}>
      <section class="launch" aria-label={t("providers.launch.title")} data-status={l().status}>
        <header class="launch__head">
          <span class="launch__title">{t("providers.launch.title")}</span>
          <Badge size="sm" tone={TONE[l().status]}>
            <StatusDot tone={TONE[l().status]} />
            {t(`providers.launch.status.${l().status}` as const)}
          </Badge>
          <Show when={l().status === "confirmed" && l().hash}>
            <span class="launch__hash ui-tnum">{t("providers.launch.hash", { hash: l().hash!.slice(0, 8) })}</span>
          </Show>
        </header>
        <Show when={line()} fallback={<p class="launch__empty">{l().editable ? t("providers.launch.customEmpty") : t("providers.launch.none")}</p>}>
          <code class="launch__line" aria-label={t("providers.confirm.line")}>{line()}</code>
        </Show>
        <p class="launch__note">{l().verified ? t("providers.launch.verified", { name: props.provider.name }) : t("providers.launch.unverified", { name: props.provider.name })}</p>
        <div class="launch__actions">
          <Button size="sm" variant={l().status === "confirmed" ? "secondary" : "primary"} disabled={!l().editable && !l().resolved && l().status !== "stale"} onClick={() => setOpen(true)}>
            {l().status === "unconfirmed" ? t("providers.launch.confirm") : t("providers.launch.reconfirm")}
          </Button>
          <Show when={l().status !== "unconfirmed"}>
            <Button size="sm" variant="ghost" onClick={() => void revoke()}>{t("providers.launch.revoke")}</Button>
          </Show>
        </div>
        <ConfirmLaunchDialog open={open()} provider={props.provider} onClose={() => setOpen(false)} onConfirm={confirm} />
      </section>
    </Show>
  );
}
