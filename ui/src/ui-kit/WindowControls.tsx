import { getCurrentWindow } from "@tauri-apps/api/window";
import { t } from "../i18n";
import { Icon } from "./Icon";
import { Minus, Square, X } from "./icons";

/** What the buttons do; injectable so tests run without a Tauri window. */
export interface WindowActions {
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
}

/** The current Tauri window. Closing goes through CloseRequested, so the unsaved-buffer guard still asks first. */
function tauriActions(): WindowActions {
  const run = (f: () => Promise<void>) => {
    if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) return;
    void f().catch((err) => console.warn("[window]", err));
  };
  return {
    minimize: () => run(() => getCurrentWindow().minimize()),
    toggleMaximize: () => run(() => getCurrentWindow().toggleMaximize()),
    close: () => run(() => getCurrentWindow().close()),
  };
}

/**
 * Minimize, maximize and close at the right edge of the title bar, for Windows, where the window has no native frame
 * (one title bar instead of a native one above the app's own). Not shown on macOS (traffic lights) or Linux (native frame).
 */
export function WindowControls(props: { actions?: WindowActions }) {
  const actions = props.actions ?? tauriActions();
  return (
    <div class="ui-window-controls" role="group" aria-label={t("windowControls.label")}>
      <button type="button" class="ui-window-controls__btn" aria-label={t("windowControls.minimize")} title={t("windowControls.minimize")} onClick={() => actions.minimize()}>
        <Icon icon={Minus} size={14} />
      </button>
      <button type="button" class="ui-window-controls__btn" aria-label={t("windowControls.maximize")} title={t("windowControls.maximize")} onClick={() => actions.toggleMaximize()}>
        <Icon icon={Square} size={12} />
      </button>
      <button type="button" class="ui-window-controls__btn" data-kind="close" aria-label={t("windowControls.close")} title={t("windowControls.close")} onClick={() => actions.close()}>
        <Icon icon={X} size={14} />
      </button>
    </div>
  );
}
