import { Show } from "solid-js";
import { t } from "../../i18n";
import type { AgentRow } from "../../store/agents";
import { Badge, CircleCheck, CircleX, Clock, TriangleAlert, type Tone } from "../../ui-kit";
import type { LucideIcon } from "lucide-solid";
import { runResults } from "./store";
import type { RepoTest } from "./types";

interface Chip {
  tone: Tone;
  icon: LucideIcon;
  text: string;
  title: string;
}

/** What the chip says for the results of one run; undefined when there is nothing to show. */
export function chipOf(results: RepoTest[]): Chip | undefined {
  const shown = results.filter((r) => r.status !== "noTests");
  if (!shown.length) return undefined;
  if (shown.some((r) => r.status === "running" || r.status === "waiting")) return { tone: "info", icon: Clock, text: t("autotest.chip.running"), title: t("autotest.chip.runningTip") };
  const failed = shown.filter((r) => r.status === "failed");
  if (failed.length) {
    const n = failed.reduce((sum, r) => sum + (r.summary?.matched ? r.summary.failed : 0), 0);
    const text = n > 0 ? t("autotest.chip.failed", { n }) : t("autotest.chip.failedPlain");
    return { tone: "danger", icon: CircleX, text, title: t("autotest.chip.failedTip") };
  }
  if (shown.some((r) => r.status === "timeout" || r.status === "error")) return { tone: "warn", icon: TriangleAlert, text: t("autotest.chip.problem"), title: t("autotest.chip.problemTip") };
  const n = shown.reduce((sum, r) => sum + (r.summary?.matched ? r.summary.passed : 0), 0);
  return { tone: "ok", icon: CircleCheck, text: n > 0 ? t("autotest.chip.passed", { n }) : t("autotest.chip.passedPlain"), title: t("autotest.chip.passedTip") };
}

/** The test result on the run card and the finished-run row. Badge only: the card itself is a button. */
export default function AutotestChip(props: { agent: AgentRow }) {
  const chip = () => chipOf(runResults(props.agent.agentId));
  return (
    <Show when={chip()}>
      {(c) => (
        <Badge size="sm" tone={c().tone} icon={c().icon} title={c().title} class="autotest-chip">
          {c().text}
        </Badge>
      )}
    </Show>
  );
}
