import { Show } from "solid-js";
import type { PermissionItem, QuestionItem } from "../../store/agent-reducer";
import { Ban, CircleQuestionMark, Icon, ShieldAlert, ShieldCheck, TriangleAlert } from "../../ui-kit";
import { t } from "../../i18n";

// A permission card or a question in somebody else's run (Team, docs/team.md): shown, never answerable. These components have no
// buttons and no callbacks, so a teammate's transcript has no path to answer anything on the owner's machine.

const plain = (s: string) => s.replace(/`/g, "");

export function SharedPermission(props: { item: PermissionItem }) {
  const outcome = () => props.item.outcome;
  const text = () => (!outcome() ? t("team.run.perm.waiting") : outcome() === "allow" ? t("team.run.perm.allowed") : outcome() === "deny" ? t("team.run.perm.denied") : t("team.run.perm.cancelled"));
  return (
    <div class="perm perm--done" data-outcome={outcome()} data-readonly="" data-testid="shared-permission" role="status">
      <Icon icon={!outcome() ? ShieldAlert : outcome() === "allow" ? ShieldCheck : outcome() === "deny" ? Ban : TriangleAlert} size={14} />
      <span class="perm__done-text">
        {text()}: <span class="ui-mono">{props.item.intent.rawCommand?.trim() || plain(props.item.intent.summary)}</span>
      </span>
    </div>
  );
}

export function SharedQuestion(props: { item: QuestionItem }) {
  const open = () => !props.item.answer && !props.item.cancelled;
  return (
    <div class="perm perm--done" data-readonly="" data-testid="shared-question" role="status">
      <Icon icon={CircleQuestionMark} size={14} />
      <span class="perm__done-text">
        {props.item.prompt} <Show when={open()} fallback={<strong>{props.item.cancelled ? t("chat.q.notAnswered") : t("team.run.q.answered")}</strong>}><strong>{t("team.run.q.waiting")}</strong></Show>
      </span>
    </div>
  );
}
