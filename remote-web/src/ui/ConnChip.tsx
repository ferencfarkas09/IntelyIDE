import { Show } from "solid-js";
import { Badge } from "@ui/ui-kit/Badge";
import { state } from "../core/app";
import { CircleCheck, Clock, TriangleAlert, Unplug } from "@ui/ui-kit/icons";
import { clock } from "./format";

/** Live / Reconnecting / Mac offline (remote-plan S1). State is always icon + word. */
export function ConnChip() {
  return (
    <span data-testid="conn" data-conn={state.conn}>
      <Show when={state.conn === "live"}>
        <Badge tone="ok" icon={CircleCheck} size="sm">
          Live
        </Badge>
      </Show>
      <Show when={state.conn === "connecting" || state.conn === "reconnecting"}>
        <Badge tone="warn" icon={Clock} size="sm">
          {state.conn === "connecting" ? "Connecting" : "Reconnecting"}
        </Badge>
      </Show>
      <Show when={state.conn === "macOffline"}>
        <Badge tone="danger" icon={Unplug} size="sm">
          Mac offline{state.macLastSeen ? ` · ${clock(state.macLastSeen)}` : ""}
        </Badge>
      </Show>
      <Show when={state.conn === "paused" || state.conn === "stopped"}>
        <Badge tone="neutral" icon={TriangleAlert} size="sm">
          Paused
        </Badge>
      </Show>
    </span>
  );
}
