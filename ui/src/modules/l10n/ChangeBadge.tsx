import { Show } from "solid-js";
import { t } from "../../i18n";
import { Badge, Globe } from "../../ui-kit";
import { badgeFor } from "./logic";
import { reportOf } from "./store";

/** After the file name in the Changes tree: how many translations the key changes in this file still need. */
export default function ChangeBadge(props: { repoId: string; path: string }) {
  const b = () => badgeFor(reportOf(props.repoId), props.path);
  return (
    <Show when={b()}>
      {(badge) => (
        <Badge
          class="l10n-badge"
          size="sm"
          numeric
          icon={Globe}
          tone={badge().missing > 0 ? "warn" : "info"}
          title={badge().problems ? t("l10n.badgeFix", { missing: badge().missing, problems: badge().problems }) : t("l10n.badge", { missing: badge().missing })}
        >
          {badge().missing + badge().problems}
        </Badge>
      )}
    </Show>
  );
}
