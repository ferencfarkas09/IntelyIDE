import { createMemo, onMount, Show } from "solid-js";
import { execute } from "../../platform/commands";
import { isForeign } from "../../store/agentScope";
import { agentAnnouncement, agentRow, agentRows, agentsError, agentsLoaded, agentView, bannerDismissed, dismissBanner, interruptRun, isInterrupting, needsYouCount, rewindRun, selectAgent, selectedAgentId, sendMessage, sendNote, startAgentStore } from "../../store/agents";
import { ArrowLeft, Badge, Button, CircleAlert, EmptyState, Plus, Skeleton, toast } from "../../ui-kit";
import { t, type MessageKey } from "../../i18n";
import { AgentList } from "./AgentList";
import { ModeBanner, ThrottleBanner } from "./Banners";
import { effectiveMode } from "./modes";
import { Composer } from "./Composer";
import { noteFailure } from "./Notes";
import { RunHeader } from "./RunHeader";
import { Transcript } from "./Transcript";
import "./chat.css";

/** Header, transcript and composer of one run. Used by the dock tab and by the Agent workspace. */
export function RunView(props: { agentId: string }) {
  const agent = createMemo(() => agentRow(props.agentId));
  const view = createMemo(() => agentView(props.agentId));
  const fail = (title: MessageKey) => (e: unknown) => toast.error(t(title), (e as { message?: string }).message ?? String(e));
  return (
    <Show when={agent()} fallback={<EmptyState icon={CircleAlert} size="sm" title={t("chat.gone")} />}>
      {(a) => (
        <>
          <RunHeader agent={a()} stopping={isInterrupting(a().agentId)} onInterrupt={() => void interruptRun(a().agentId).catch(fail("chat.fail.interrupt"))} onRewind={() => void rewindRun(a().agentId).catch(fail("chat.fail.rewind"))} />
          <Show when={view()} fallback={<div class="chat__loading"><Skeleton height={48} /><Skeleton height={96} /></div>}>
            {(v) => (
              <>
                <Show when={v().banner && !bannerDismissed(a().agentId, v().banner!.seq) ? v().banner : undefined}>
                  {(b) => <ModeBanner banner={b()} mode={effectiveMode(a())} onDismiss={() => dismissBanner(a().agentId, b().seq)} />}
                </Show>
                <Transcript agentId={a().agentId} view={v()} />
                <Show when={v().throttle}>{(th) => <ThrottleBanner throttle={th()} canStop={v().turnActive} onStop={() => void interruptRun(a().agentId).catch(fail("chat.fail.interrupt"))} />}</Show>
                <Show when={isForeign(a().repoIds)}>
                  <p class="chat__readonly" role="note">{t("scope.readOnly")}</p>
                </Show>
                <Show when={!isForeign(a().repoIds)}>
                <Composer
                  agentId={a().agentId}
                  repoIds={a().repoIds}
                  running={v().turnActive}
                  provider={a().provider}
                  attachmentsCap={a().caps.attachments}
                  slashCommands={a().slashCommands}
                  stopping={isInterrupting(a().agentId)}
                  onSend={(text, attachments, files) => void sendMessage(a().agentId, text, attachments, files).catch(fail("chat.fail.send"))}
                  onStop={() => void interruptRun(a().agentId).catch(fail("chat.fail.interrupt"))}
                  onNote={(v().caps ?? a().caps)?.notes === true ? (text) => sendNote(a().agentId, text).catch((e) => { noteFailure(e); throw e; }) : undefined}
                />
                </Show>
              </>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}

/** Dock tab: the list of agent runs and the transcript of the selected one. Lazy-loaded by the dock. */
export function ChatPanel() {
  onMount(() => startAgentStore());
  return (
    <div class="chat" data-testid="chat-panel">
      <div class="ui-sr-only" role="status" aria-live="polite">
        {agentAnnouncement()}
      </div>
      <div class="chat__bar">
        <Show when={selectedAgentId()} fallback={<span class="chat__title">{t("chat.runs")}</span>}>
          <Button size="sm" variant="ghost" icon={ArrowLeft} onClick={() => void selectAgent(null)}>
            {t("chat.runs")}
            <Show when={needsYouCount() > 0}>
              <Badge tone="warn" numeric size="sm" title={t("chat.runsWaiting")}>
                {needsYouCount()}
              </Badge>
            </Show>
          </Button>
        </Show>
        <span class="chat__grow" />
        <Button size="sm" variant="primary" icon={Plus} onClick={() => void execute("runs.new")}>
          {t("chat.newRun")}
        </Button>
      </div>
      <Show when={agentsError()}>
        <EmptyState tone="danger" icon={CircleAlert} title={t("chat.loadFailed")} description={agentsError()} />
      </Show>
      <Show when={!agentsError()}>
        <Show
          when={agentsLoaded()}
          fallback={
            <div class="chat__loading">
              <Skeleton height={32} />
              <Skeleton height={32} />
              <Skeleton height={32} />
            </div>
          }
        >
          <Show when={selectedAgentId()} fallback={<AgentList rows={agentRows()} onSelect={(id) => void selectAgent(id)} />}>
            {(id) => <RunView agentId={id()} />}
          </Show>
        </Show>
      </Show>
    </div>
  );
}
