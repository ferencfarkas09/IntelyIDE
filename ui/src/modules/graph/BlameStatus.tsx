import { t } from "../../i18n";
import { blameEnabled, toggleBlame } from "./blame";

/** Status bar toggle for the blame gutter; shown while a file tab is active. */
export default function BlameStatus() {
  return (
    <button type="button" class="sb__item" aria-pressed={blameEnabled()} title={t("graph.blame.title")} onClick={toggleBlame}>
      {blameEnabled() ? t("graph.blame.on") : t("graph.blame.off")}
    </button>
  );
}
