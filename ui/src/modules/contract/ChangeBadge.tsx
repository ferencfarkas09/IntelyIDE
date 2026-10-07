import { Show } from "solid-js";
import { t } from "../../i18n";
import { Badge, Plug } from "../../ui-kit";
import { badgeFor } from "./logic";
import { report } from "./store";

/** After the file name in the Changes tree: the file contains API calls; the tone says whether the detector found problems in them. */
export default function ChangeBadge(props: { repoId: string; path: string }) {
  const b = () => badgeFor(report(), props.repoId, props.path);
  return (
    <Show when={b()}>
      {(badge) => {
        const problems = () => badge().errors + badge().warnings;
        return (
          <Badge class="contract-badge" size="sm" numeric icon={Plug} tone={badge().errors ? "danger" : badge().warnings ? "warn" : "neutral"} title={problems() ? t("contract.badgeProblems", { calls: badge().calls, problems: problems() }) : t("contract.badge", { calls: badge().calls })}>
            {badge().calls}
          </Badge>
        );
      }}
    </Show>
  );
}
