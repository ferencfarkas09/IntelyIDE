import type { Effort } from "@intely/protocol";
import { createUniqueId, Show } from "solid-js";
import { modelLabel } from "../../components/chat/format";
import { t, type MessageKey } from "../../i18n";
import type { RoleProviderCaps } from "../../ipc/roles";
import { Button, ChoiceCard, Input, SegmentedControl, Select } from "../../ui-kit";
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
  /** The model or effort shown is the one remembered from the last start of this role (nothing was picked now). */
  remembered?: boolean;
  /** Back to the role's own model and effort. */
  onReset?: () => void;
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
  const ids = { note: createUniqueId() };
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
  /** The effort the run gets now: the picked level, else the role's own (none when that is unknown or the model has none). */
  const effortNow = () => (props.value.effort && effort().levels.includes(props.value.effort) ? props.value.effort : props.defaultEffort && effort().levels.includes(props.defaultEffort) ? props.defaultEffort : undefined);
  // The segments show the level's id as the CLI spells it (low ... max); the full name is the accessible name and the tooltip.
  const effortOptions = () => effort().levels.map((l) => ({ value: l, label: l, ariaLabel: effortText(l), tooltip: effortText(l), disabled: props.disabled }));
  const picked = () => props.value.model !== undefined || props.value.effort !== undefined;

  const setModel = (model: string | undefined) => {
    const levels = effortChoice(model?.trim() || props.defaultModel, props.caps, props.provider).levels;
    props.onChange({ ...props.value, model, effort: effortAfterModelChange(props.value.effort, levels) });
  };
  const chooseModel = (v: string) => (v === OTHER_MODEL ? setModel("") : setModel(v || undefined));
  const badTyped = () => otherOpen() && !isClaudeModelId(props.value.model!.trim());

  return (
    <div class="runpicker" role="group" aria-label={t("runpicker.legend")}>
      <label class="newrun__field runpicker__model">
        <span class="newrun__label">{t("runpicker.model")}</span>
        <Select aria-label={t("runpicker.model")} value={otherOpen() ? OTHER_MODEL : (props.value.model ?? "")} options={modelOptions()} onChange={chooseModel} disabled={props.disabled} />
      </label>
      <Show when={otherOpen()}>
        <label class="newrun__field runpicker__other">
          <span class="newrun__label" data-minor="">{t("runpicker.otherModelLabel")}</span>
          <Input
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
      <div class="newrun__field runpicker__effort">
        <span class="newrun__label">{t("runpicker.effort")}</span>
        <Show when={effort().levels.length > 0}>
          <SegmentedControl<Effort | ""> size="lg" fullWidth aria-label={t("runpicker.effort")} options={effortOptions()} value={effortNow() ?? ""} onChange={(v) => v && props.onChange({ ...props.value, effort: v })} />
        </Show>
        <small class="newrun__provider-note" id={ids.note}>
          {effort().unknownModel ? t("runpicker.unknownModel") : effort().levels.length === 0 && runModel() ? t("runpicker.noEffort") : t("runpicker.effortHint")}
        </small>
      </div>
      <Show when={props.remembered || picked()}>
        <div class="runpicker__remembered" role={props.remembered ? "status" : undefined}>
          <Show when={props.remembered}>
            <small class="newrun__provider-note">{t("runpicker.remembered")}</small>
          </Show>
          <Button size="sm" variant="ghost" onClick={() => props.onReset?.()} disabled={props.disabled}>
            {t("runpicker.reset")}
          </Button>
        </div>
      </Show>
      <Show when={props.ultracodeOffered}>
        <ChoiceCard
          type="switch"
          class="runpicker__ultra"
          checked={props.value.ultracode === true}
          onChange={(on) => props.onChange({ ...props.value, ultracode: on || undefined })}
          title={t("runpicker.ultracode")}
          description={t("runpicker.ultracodeNotice")}
          tooltip={t("runpicker.ultracodeAria")}
          disabled={props.disabled}
        />
      </Show>
    </div>
  );
}
