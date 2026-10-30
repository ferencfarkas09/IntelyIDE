import { createSignal, Show } from "solid-js";
import { t } from "../../i18n";
import type { CockpitSlotProps } from "../../platform/cockpitSlots";
import { Button, toast } from "../../ui-kit";
import { canCompact, compact, compactBusy, continueFresh, nudged, route, sendNudge } from "./actions";
import { cacheReadShare, MOSTLY, overThreshold } from "./logic";
import { threshold } from "./prefs";
import "./tokensaver.css";

const failed = (key: "tokensaver.fail.nudge" | "tokensaver.fail.compact" | "tokensaver.fail.fresh") => (e: unknown) => toast.error(t(key), (e as { message?: string })?.message ?? String(e));

/** Beside a repeated-read warning: "Tell the agent", once per file and run. */
export function NudgeButton(props: CockpitSlotProps) {
  const path = () => String(props.warning?.params.path ?? "");
  const count = () => Number(props.warning?.params.count) || 0;
  const [busy, setBusy] = createSignal(false);
  const send = () => {
    setBusy(true);
    sendNudge(props.runId, path(), count())
      .then((ok) => ok && toast.success(t("tokensaver.nudge.sent")), failed("tokensaver.fail.nudge"))
      .finally(() => setBusy(false));
  };
  return (
    <Show when={props.warning?.kind === "repeatedReads" && path()}>
      <Show when={!nudged(props.runId, path())} fallback={<span class="ts__sent">{t("tokensaver.nudge.done")}</span>}>
        <Button size="sm" variant="secondary" class="ts__nudge" loading={busy()} disabled={route(props.runId) === "none"} title={route(props.runId) === "none" ? t("tokensaver.nudge.wait") : t("tokensaver.nudge.hint")} onClick={send}>
          {t("tokensaver.nudge.button")}
        </Button>
      </Show>
    </Show>
  );
}

/** Under the context window, once it passes the threshold: continue in a fresh run, or compact the conversation. */
export function ContextCard(props: CockpitSlotProps) {
  const [busy, setBusy] = createSignal(false);
  const fresh = () => {
    setBusy(true);
    const changed = props.data.files.filter((f) => f.edits > 0).map((f) => f.path);
    continueFresh(props.runId, changed)
      .then((opened) => opened || toast.warn(t("toAgent.noDialog")), failed("tokensaver.fail.fresh"))
      .finally(() => setBusy(false));
  };
  return (
    <Show when={overThreshold(props.data.context.fraction, threshold())}>
      <section class="ts-card" aria-label={t("tokensaver.context.title")} data-testid="tokensaver-context">
        <h3 class="ts-card__title">{t("tokensaver.context.title")}</h3>
        <p class="ts-card__text">{t("tokensaver.context.body", { percent: Math.round((props.data.context.fraction ?? 0) * 100) })}</p>
        <Show when={props.data.context.source === "estimated"}>
          <p class="ts-card__muted">{t("tokensaver.context.estimated")}</p>
        </Show>
        <div class="ts-card__actions">
          <Button size="sm" variant="primary" loading={busy()} onClick={fresh}>{t("tokensaver.context.fresh")}</Button>
          <Show when={canCompact(props.runId)}>
            <Button size="sm" variant="secondary" disabled={compactBusy(props.runId)} title={compactBusy(props.runId) ? t("tokensaver.context.compactWait") : t("tokensaver.context.compactHint")} onClick={() => void compact(props.runId).catch(failed("tokensaver.fail.compact"))}>
              {t("tokensaver.context.compact")}
            </Button>
          </Show>
        </div>
        <p class="ts-card__muted">{t("tokensaver.context.freshHint")}</p>
      </section>
    </Show>
  );
}

/** Under the usage tiles, only when the provider reported tokens and a cost: how much of it was the conversation read again. */
export function CacheShare(props: CockpitSlotProps) {
  const share = () => cacheReadShare(props.data.totals);
  return (
    <Show when={share()}>
      {(s) => (
        <p class="ts-share" data-testid="tokensaver-share">
          <span>{t("tokensaver.cost.share", { percent: Math.round(s() * 100) })}</span>
          <Show when={s() >= MOSTLY}>
            <span> {t("tokensaver.cost.mostly")}</span>
          </Show>
          <span class="ts-card__muted"> {t("tokensaver.cost.tip")}</span>
        </p>
      )}
    </Show>
  );
}
