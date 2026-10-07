import { Show } from "solid-js";
import { t } from "../../i18n";
import { openDockTab } from "../../platform/dock";
import { tasksView } from "../../store/happyNt";
import { Badge, Icon, ListChecks, Tooltip } from "../../ui-kit";
import { openCount } from "./logic";

/** Status-bar item: the number of open tasks assigned to you. Click opens the Tasks tab. */
export default function TasksItem() {
  const open = () => openCount(tasksView());
  const label = () => t("ht.item.label", { count: open() });
  return (
    <Tooltip label={label()}>
      <button type="button" class="sb__item sb__attention" data-stale={tasksView().stale ? "" : undefined} aria-label={label()} onClick={() => openDockTab("tasks")}>
        <Icon icon={ListChecks} size={12} />
        <Show when={open() > 0}>
          <Badge size="sm" numeric>{open() > 99 ? "99+" : open()}</Badge>
        </Show>
      </button>
    </Tooltip>
  );
}
