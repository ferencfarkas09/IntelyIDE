import { createSignal, Show } from "solid-js";
import { t, fmt } from "../../i18n";
import { ipc } from "../../ipc";
import { Badge, Button, Download, Popover, toast } from "../../ui-kit";
import { applyNotice, updateNotice } from "./state";
import "./updates.css";

/** Status-bar chip "Update available · x.y.z" and its card. Notification only: the card opens the release page. */
export default function UpdateChip() {
  const [open, setOpen] = createSignal(false);
  const latest = () => updateNotice()?.latest;
  const date = () => {
    const at = Date.parse(latest()?.publishedAt ?? "");
    return Number.isNaN(at) ? "" : fmt.date(at);
  };
  async function openPage(close: () => void) {
    const url = latest()?.url;
    if (!url) return;
    try {
      await ipc.happy.openExternal(url);
      close();
    } catch (e) {
      toast.error((e as { message?: string }).message ?? t("updates.openFailed"));
    }
  }
  async function skip(close: () => void) {
    const version = latest()?.version;
    if (!version) return;
    try {
      applyNotice(await ipc.updates.dismiss(version));
    } finally {
      close();
    }
  }
  return (
    <Popover
      open={open()}
      onOpenChange={setOpen}
      placement="top-end"
      aria-label={t("updates.card.aria")}
      class="upd-popover"
      trigger={(p) => (
        <button {...p} type="button" class="sb__item sb__attention upd-chip" aria-label={t("updates.chip.aria", { version: latest()?.version ?? "" })}>
          <Download size={12} aria-hidden="true" />
          <span class="ui-tnum">{t("updates.chip", { version: latest()?.version ?? "" })}</span>
        </button>
      )}
    >
      {(api) => (
        <div class="upd-card">
          <header class="upd-card__head">
            <strong>{t("updates.card.title", { version: latest()?.version ?? "" })}</strong>
            <Show when={latest()?.prerelease}>
              <Badge tone="warn">{t("updates.prerelease")}</Badge>
            </Show>
          </header>
          <p class="upd-card__meta">
            {t("updates.card.current", { version: updateNotice()?.currentVersion ?? "" })}
            <Show when={date()}> · {date()}</Show>
          </p>
          <Show when={latest()?.notes}>
            <pre class="upd-card__notes" aria-label={t("updates.card.notes")}>{latest()?.notes}</pre>
          </Show>
          <p class="upd-card__note">{t("updates.honest")}</p>
          <p class="upd-card__note">{t("updates.sha")}</p>
          <footer class="upd-card__foot">
            <Button size="sm" variant="primary" onClick={() => void openPage(api.close)}>
              {t("updates.openPage")}
            </Button>
            <Button size="sm" onClick={api.close}>{t("updates.later")}</Button>
            <Button size="sm" variant="ghost" onClick={() => void skip(api.close)}>{t("updates.skip")}</Button>
          </footer>
        </div>
      )}
    </Popover>
  );
}
