import { lazy, Show } from "solid-js";
import { ntOn } from "../../store/happyNt";

const ToastWatch = lazy(() => import("./ToastWatch"));

/** The overlay slot: renders nothing, and fetches nothing, until Notifications is switched on. */
export default function Gate() {
  return (
    <Show when={ntOn("notifications")}>
      <ToastWatch />
    </Show>
  );
}
