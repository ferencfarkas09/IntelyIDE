import type { Effort } from "@intely/protocol";
import { createUniqueId, Show } from "solid-js";
import { modelLabel } from "../../components/chat/format";
import { t, type MessageKey } from "../../i18n";
import type { RoleProviderCaps } from "../../ipc/roles";
import { Input, Select, Switch } from "../../ui-kit";
import { effortAfterModelChange, effortChoice, isClaudeModelId, modelChoices, OTHER_MODEL, type RunPick } from "./logic";
import "./runpicker.css";

export interface RunPickerProps {
  caps: readonly RoleProviderCaps[];
  provider: string;
  /** What the run uses when nothing is picked: the role's model and effort, or Auto's. */
  defaultModel?: string;
  defaultEffort?: Effort | null;
  value: RunPick;
  onChange: (next: RunPick) => void;
  /** A Claude run of one role (not Auto, not another provider). */
  ultracodeOffered: boolean;
  disabled?: boolean;
}

const EFFORT_KEY: Record<Effort, MessageKey> = {
  low: "runpicker.effortLevel.low",
  medium: "runpicker.effortLevel.medium",
  high: "runpicker.effortLevel.high",
  xhigh: "runpicker.effortLevel.xhigh",
  max: "runpicker.effortLevel.max",
};
export const effortText = (e: Effort): string => t(EFFORT_KEY[e]);

/** New run: the exact model and effort of the run, and ultracode. Untouched, it picks nothing and the role's own values apply. */
export default function RunPicker(props: RunPickerProps) {
  const ids = { legend: createUniqueId(), note: createUniqueId() };
  const models = () => modelChoices(props.caps, props.provider);
  const listed = (id: string | undefined) => id !== undefined && models().some((m) => m.id === id);
  /** "Other model id..." is open: a picked model that is not in the list (an empty one right after choosing it). */
  const otherOpen = () => props.value.model !== undefined && !listed(props.value.model);
  const runModel = () => props.value.model?.trim() || props.defaultModel;
  const effort = () => effortChoice(runModel(), props.caps, props.provider);
  const labelOf = (id: string) => models().find((m) => m.id === id)?.label ?? modelLabel(id);
  const otherAllowed = () => props.provider === "claude";

  const modelOptions = () => [
    { value: "", label: props.defaultModel ? t("runpicker.default", { value: labelOf(props.defaultModel) }) : t("runpicker.defaultUnknown") },
    ...models().map((m) => ({ value: m.id, label: m.label })),
    ...(otherAllowed() ? [{ value: OTHER_MODEL, label: t("runpicker.otherModel") }] : []),
  ];
  const effortOptions = () => [
    { value: "", label: t("runpicker.default", { value: props.defaultEffort ? effortText(props.defaultEffort) : t("runs.na") }) },
    ...effort().levels.map((l) => ({ value: l, label: effortText(l) })),
  ];

  const setModel = (model: string | undefined) => {
    const levels = effortChoice(model?.trim() || props.defaultModel, props.caps, props.provider).levels;
    props.onChange({ ...props.value, model, effort: effortAfterModelChange(props.value.effort, levels) });
  };
  const chooseModel = (v: string) => (v === OTHER_MODEL ? setModel("") : setModel(v || undefined));
  const badTyped = () => otherOpen() && !isClaudeModelId(props.value.model!.trim());

  return (
    <fieldset class="newrun__field runpicker" aria-labelledby={ids.legend}>
      <legend class="newrun__label" id={ids.legend}>
        {t("runpicker.legend")}
      </legend>
      <div class="runpicker__row">
        <label class="runpicker__cell">
          <span class="runpicker__label">{t("runpicker.model")}</span>
          <Select size="sm" aria-label={t("runpicker.model")} value={otherOpen() ? OTHER_MODEL : (props.value.model ?? "")} options={modelOptions()} onChange={chooseModel} disabled={props.disabled} />
        </label>
        <label class="runpicker__cell">
          <span class="runpicker__label">{t("runpicker.effort")}</span>
          <Select
            size="sm"
            aria-label={t("runpicker.effort")}
            aria-describedby={ids.note}
            value={props.value.effort && effort().levels.includes(props.value.effort) ? props.value.effort : ""}
            options={effortOptions()}
            onChange={(v) => props.onChange({ ...props.value, effort: (v || undefined) as Effort | undefined })}
            disabled={props.disabled || effort().levels.length === 0}
            title={effort().levels.length === 0 ? t("runpicker.noEffort") : t("runpicker.effortHint")}
          />
        </label>
      </div>
      <Show when={otherOpen()}>
        <label class="runpicker__other">
          <span class="runpicker__label">{t("runpicker.otherModelLabel")}</span>
          <Input
            size="sm"
            aria-label={t("runpicker.otherModelLabel")}
            placeholder={t("runpicker.otherModelPlaceholder")}
            value={props.value.model ?? ""}
            invalid={badTyped() && props.value.model !== ""}
            spellcheck={false}
            autocomplete="off"
            onInput={(e) => setModel(e.currentTarget.value)}
            disabled={props.disabled}
          />
        </label>
        <Show when={badTyped()}>
          <small class="newrun__provider-note" role="status">
            {t("runpicker.badModel")}
          </small>
        </Show>
      </Show>
      <small class="newrun__provider-note" id={ids.note}>
        {effort().unknownModel ? t("runpicker.unknownModel") : effort().levels.length === 0 && runModel() ? t("runpicker.noEffort") : t("runpicker.effortHint")}
      </small>
      <Show when={props.ultracodeOffered}>
        <div class="runpicker__ultra">
          <Switch size="sm" checked={props.value.ultracode === true} onChange={(on) => props.onChange({ ...props.value, ultracode: on || undefined })} aria-label={t("runpicker.ultracodeAria")} disabled={props.disabled} label={t("runpicker.ultracode")} />
          <small class="newrun__provider-note">{t("runpicker.ultracodeNotice")}</small>
        </div>
      </Show>
    </fieldset>
  );
}
