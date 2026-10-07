import { For } from "solid-js";
import { Dynamic } from "solid-js/web";
import { statusItems } from "../../platform/statusbar";
import { t } from "../../i18n";
import "./statusbar.css";

/** Status bar slots: left items, a flexible gap, right items. The built-ins live in `items.tsx` and register in shell/builtin. */
export function StatusBar() {
  return (
    <footer class="sb" aria-label={t("statusbar.aria")}>
      <For each={statusItems("left")}>{(item) => <Dynamic component={item.component} />}</For>
      <span class="sb__grow" />
      <For each={statusItems("right")}>{(item) => <Dynamic component={item.component} />}</For>
    </footer>
  );
}
