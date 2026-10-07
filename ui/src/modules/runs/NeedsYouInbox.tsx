import { For, Show } from "solid-js";
import { PermissionCard, QuestionCard } from "../../components/chat/Cards";
import { PlanApprovalCard } from "../../components/chat/PlanApprovalCard";
import { t } from "../../i18n";
import { isExitPlan } from "../../store/agent-reducer";
import { agentRow, answerPermission, answerQuestion, selectAgent } from "../../store/agents";
import { repoConfig } from "../../store/workspace";
import { Button, CircleCheck, EmptyState, ScrollArea, toast } from "../../ui-kit";
import { inbox } from "./inbox";
import type { InboxEntry } from "./inboxLogic";
import { roleColor } from "./roleColors";
import { setCentreView } from "./state";

const fail = (e: unknown) => toast.error(t("runs.inbox.sendFail"), (e as { message?: string }).message ?? String(e));

function Entry(props: { entry: InboxEntry }) {
  const e = () => props.entry;
  const repos = () => e().repoIds.map((id) => repoConfig(id)?.name ?? id).join(", ");
  return (
    <li class="inbox__entry">
      <div class="inbox__head">
        <span class="run-card__swatch" style={{ background: roleColor(e().role) ?? "var(--text-4)" }} aria-hidden="true" />
        <span class="inbox__role">{e().role}</span>
        <span class="inbox__run ui-truncate" title={e().runTitle}>
          {e().runTitle}
        </span>
        <span class="inbox__repos ui-truncate">{repos()}</span>
        <Button size="sm" variant="ghost" onClick={() => (setCentreView("run"), void selectAgent(e().agentId))}>
          {t("runs.inbox.open")}
        </Button>
      </div>
      <Show
        when={e().kind === "permission"}
        fallback={<QuestionCard item={(e() as Extract<InboxEntry, { kind: "question" }>).item} onAnswer={(answer) => void answerQuestion(e().agentId, e().item.reqId, answer).catch(fail)} />}
      >
        <Show
          when={isExitPlan((e() as Extract<InboxEntry, { kind: "permission" }>).item.intent)}
          fallback={<PermissionCard item={(e() as Extract<InboxEntry, { kind: "permission" }>).item} onAnswer={(decision) => void answerPermission(e().agentId, e().item.reqId, decision).catch(fail)} />}
        >
          <PlanApprovalCard item={(e() as Extract<InboxEntry, { kind: "permission" }>).item} mcp={agentRow(e().agentId)?.mcp} onAnswer={(decision, extra) => void answerPermission(e().agentId, e().item.reqId, decision, extra).catch(fail)} />
        </Show>
      </Show>
    </li>
  );
}

/** Pending permissions and questions of every run in one place, answerable without opening the run. */
export function NeedsYouInbox() {
  return (
    <section class="inbox" aria-label={t("runs.needsYou")}>
      <header class="inbox__bar">
        <h2 class="inbox__title">{t("runs.needsYou")}</h2>
        <span class="inbox__count ui-tnum">{t("runs.inbox.count", { n: inbox().length })}</span>
      </header>
      <Show when={inbox().length > 0} fallback={<EmptyState icon={CircleCheck} title={t("runs.inbox.none")} description={t("runs.inbox.noneDesc")} />}>
        <ScrollArea class="inbox__scroll">
          <ul class="inbox__list">
            <For each={inbox()}>{(entry) => <Entry entry={entry} />}</For>
          </ul>
        </ScrollArea>
      </Show>
    </section>
  );
}
