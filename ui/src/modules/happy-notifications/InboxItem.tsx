import { Show } from "solid-js";
import { openDockTab } from "../../platform/dock";
import { inboxView } from "../../store/happyNt";
import { Badge, Icon, Inbox, Tooltip } from "../../ui-kit";
import { barTooltip, countLabel } from "./logic";
import "./notifications.css";

/** Status-bar item: the inbox icon and, while something is unread, a count. Click opens the Inbox tab. */
export default function InboxItem() {
  const view = inboxView;
  return (
    <Tooltip label={barTooltip(view().unread, view().stale)}>
      <button
        type="button"
        class="sb__item sb__attention happy-inbox"
        data-unread={view().unread > 0 ? "" : undefined}
        data-stale={view().stale ? "" : undefined}
        aria-label={barTooltip(view().unread, view().stale)}
        onClick={() => openDockTab("inbox")}
      >
        <Icon icon={Inbox} size={12} />
        <Show when={view().unread > 0}>
          <Badge tone="accent" variant="solid" size="sm" numeric>{countLabel(view().unread)}</Badge>
        </Show>
      </button>
    </Tooltip>
  );
}
