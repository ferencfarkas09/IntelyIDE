import { Show } from "solid-js";
import { t } from "../../i18n";
import { Icon, Sparkles, Switch } from "../../ui-kit";

/**
 * The global `Experimental providers` switch (default off, remembered by the backend). While it is off nothing but Claude exists:
 * no card, no adapter, no process, no extra code is loaded.
 */
export function ExperimentalSwitch(props: { on: boolean; busy?: boolean; hidden: readonly string[]; onChange: (on: boolean) => void }) {
  return (
    <section class="pexp" aria-labelledby="pexp-title" data-on={props.on ? "" : undefined}>
      <header class="pexp__head">
        <Icon icon={Sparkles} size={16} />
        <h4 class="pexp__title" id="pexp-title">{t("providers.exp.title")}</h4>
        <span class="pexp__spacer" />
        <Switch aria-label={t("providers.exp.switch")} checked={props.on} disabled={props.busy} onChange={props.onChange} />
      </header>
      <p class="pexp__desc">{t("providers.exp.desc")}</p>
      <p class="pexp__state">{props.on ? t("providers.exp.on") : t("providers.exp.off")}</p>
      <Show when={!props.on && props.hidden.length > 0}>
        <p class="pexp__hidden">{t("providers.exp.hidden", { count: props.hidden.length, names: props.hidden.join(", ") })}</p>
      </Show>
    </section>
  );
}
