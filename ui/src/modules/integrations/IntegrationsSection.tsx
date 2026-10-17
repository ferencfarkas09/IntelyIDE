import { For, onMount, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { t } from "../../i18n";
import { closeIntegration, currentIntegration, integrations, openIntegration, type Integration } from "../../platform/integrations";
import { ArrowLeft, Badge, Button, ChevronRight, Icon } from "../../ui-kit";
import "./integrations.css";

function Card(props: { item: Integration }) {
  const item = () => props.item;
  const status = () => item().status?.();
  const body = (
    <>
      <span class="intc__icon" aria-hidden="true"><Icon icon={item().icon} size={20} /></span>
      <span class="intc__text">
        <span class="intc__name">{item().name}</span>
        <span class="intc__summary">{item().summary}</span>
      </span>
      <span class="intc__end">
        <Show when={item().planned}><Badge variant="outline" size="sm">{t("integrations.catalog.planned")}</Badge></Show>
        <Show when={!item().planned ? status() : undefined}>{(s) => <Badge tone={s().tone} size="sm">{s().label}</Badge>}</Show>
        <Show when={!item().planned}><Icon icon={ChevronRight} size={16} /></Show>
      </span>
    </>
  );
  return (
    <li>
      <Show when={!item().planned} fallback={<div class="intc" data-planned="">{body}</div>}>
        <button type="button" class="intc" data-id={item().id} onClick={() => openIntegration(item().id)}>{body}</button>
      </Show>
    </li>
  );
}

/** Settings > Integrations: the catalog of services the IDE connects to, and, after a click, the settings of one of them. */
export default function IntegrationsSection() {
  onMount(() => integrations().forEach((i) => i.load?.()));
  return (
    <Show
      when={currentIntegration()}
      fallback={
        <div class="int">
          <p class="intc-lead">{t("integrations.catalog.lead")}</p>
          <ul class="intc-list" aria-label={t("integrations.title")}>
            <For each={integrations()}>{(item) => <Card item={item} />}</For>
          </ul>
          <p class="int__note">{t("integrations.catalog.more")}</p>
        </div>
      }
    >
      {(item) => (
        <div class="int">
          <div class="intc-head">
            <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={closeIntegration}>{t("integrations.catalog.back")}</Button>
            <h3 class="intc-head__name">{item().name}</h3>
          </div>
          <Dynamic component={item().detail} />
        </div>
      )}
    </Show>
  );
}
