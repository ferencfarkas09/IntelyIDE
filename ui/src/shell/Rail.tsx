import { For, Show } from "solid-js";
import { appMode, setAppMode } from "../platform/mode";
import { activateRailItem, isRailItemPressed, railItems, type RailItem } from "../platform/rail";
import { t, type MessageKey } from "../i18n";
import { IconButton } from "../ui-kit";

const RAIL_TITLES: Record<string, MessageKey> = { commit: "rail.commit", agents: "rail.agents", settings: "rail.settings" };

function RailButton(props: { item: RailItem }) {
  const title = () => (props.item.id in RAIL_TITLES ? t(RAIL_TITLES[props.item.id]) : props.item.title);
  const count = () => props.item.badge?.() ?? 0;
  const max = () => props.item.badgeMax ?? 9;
  // The Agent workspace fills the area next to the rail: a tool window button leads back to the editor instead of opening behind it.
  const leavesAgent = () => appMode() === "agent" && !!props.item.panel;
  return (
    <span class="rail__item">
      <IconButton
        icon={props.item.icon}
        label={props.item.label?.() ?? title()}
        tooltip={props.item.soon ? t("rail.soon", { title: title() }) : props.item.label ? title() : undefined}
        shortcut={props.item.shortcut}
        size="lg"
        disabled={props.item.soon}
        pressed={props.item.soon ? undefined : !leavesAgent() && isRailItemPressed(props.item)}
        onClick={() => (leavesAgent() ? setAppMode("editor") : activateRailItem(props.item))}
        tooltipPlacement="right"
      />
      <Show when={count() > 0}>
        <span class="rail__badge ui-tnum" data-tone={props.item.badgeUrgent?.() ? "urgent" : undefined} {...(props.item.label ? { "aria-hidden": true } : { role: "status", "aria-label": `${count()} waiting for you` })}>
          {count() > max() ? `${max()}+` : count()}
        </span>
      </Show>
    </span>
  );
}

/** Tool window rail, drawn from the rail registry (platform/rail). Items with `align: "end"` sit at the bottom. */
export function Rail() {
  const start = () => railItems().filter((i) => i.align !== "end" && (i.when?.() ?? true));
  const end = () => railItems().filter((i) => i.align === "end" && (i.when?.() ?? true));
  return (
    <nav class="rail" aria-label={t("rail.label")}>
      <For each={start()}>{(item) => <RailButton item={item} />}</For>
      <span class="rail__grow" />
      <Show when={end().length}>
        <For each={end()}>{(item) => <RailButton item={item} />}</For>
      </Show>
    </nav>
  );
}
