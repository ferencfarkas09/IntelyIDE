import { createMemo, Show } from "solid-js";
import { t, type MessageKey } from "../../i18n";
import type { NewRunSlotContext } from "../../platform/newRunSlots";
import { SegmentedControl } from "../../ui-kit";
import { modeOf, presetBlocker, presetOf, PRESETS, type PresetId } from "./logic";
import { SecretGuardOffer } from "./SecretGuardOffer";
import "./presets.css";

/** Careful / Balanced / Autonomous above the permission cards of the New Run dialog. A pick is the same as a click on the card. */
export default function PresetBar(props: { ctx: NewRunSlotContext }) {
  const current = createMemo(() => presetOf(props.ctx.permission()));
  const options = createMemo(() =>
    PRESETS.map((p) => {
      const why = presetBlocker(p.id, props.ctx.supported(), props.ctx.unavailable());
      return { value: p.id, label: t(`presets.${p.id}` as MessageKey), disabled: !!why || props.ctx.disabled(), tooltip: why === "unsupported" ? t("presets.unsupported") : why };
    }),
  );
  return (
    <div class="presets">
      <SegmentedControl<PresetId | "custom"> size="sm" aria-label={t("presets.label")} options={options()} value={current() ?? "custom"} onChange={(id) => id !== "custom" && props.ctx.pickMode(modeOf(id))} />
      <p class="presets__desc">
        <Show when={current()} fallback={t("presets.custom")}>{(id) => <>{t(`presets.${id()}.desc` as MessageKey)}</>}</Show>
      </p>
      <SecretGuardOffer />
    </div>
  );
}
