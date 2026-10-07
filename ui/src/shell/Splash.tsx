import { Show } from "solid-js";
import { t } from "../i18n";
import { workspaceState } from "../store/workspace";
import { switchTarget } from "../store/workspaces";
import { BrandMark } from "../ui-kit";
import { ABOUT } from "./aboutText";
import { createPresence } from "../ui-kit/presence";

/** Covers the window from the first paint until the workspace has loaded, then fades out. */
export function Splash() {
  const { mounted, state } = createPresence(() => workspaceState() === "loading" || workspaceState() === "switching", 180);
  const switching = () => workspaceState() === "switching";
  const label = () => {
    if (!switching()) return t("splash.loading");
    const name = switchTarget()?.name;
    return name ? t("switch.switching", { name }) : t("switch.closing");
  };
  return (
    <Show when={mounted()}>
      <div class="splash" data-state={state()} role="status" aria-label={label()} aria-busy={switching() ? "true" : undefined}>
        <BrandMark tile size={72} />
        <span class="splash__name">{switching() ? label() : ABOUT.product}</span>
      </div>
    </Show>
  );
}
