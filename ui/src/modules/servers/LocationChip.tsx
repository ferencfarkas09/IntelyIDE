import { onMount } from "solid-js";
import { t } from "../../i18n";
import { Badge, Server } from "../../ui-kit";
import { ensureServers, serverName } from "./store";

/** The name of the server a run lives on. Names come from one shared list, read once, not per row. */
export function LocationChip(props: { id: string }) {
  onMount(ensureServers);
  const name = () => serverName(props.id) ?? props.id;
  return (
    <Badge size="sm" icon={Server} class="run-location" title={t("runs.where.chip", { name: name() })}>
      {name()}
    </Badge>
  );
}
