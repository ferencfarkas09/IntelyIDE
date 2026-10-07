import { createEffect, createMemo, For, on, onCleanup, onMount, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { activeSheetRun, commitAll, commitAndPush, commitPreview, openPushDialog, pushDialogRequest, refreshAmendPrefill, repoName, setAmendMode } from "../../store/actions";
import { commitPanelSlots } from "../../platform/commitSlots";
import { checkedFiles } from "../../store/selection";
import { snapshots } from "../../store/snapshots";
import { workspace } from "../../store/workspace";
import { Badge, Check, Checkbox, FileText, GitCommitHorizontal, Icon, IconButton, Info, RepoBadge, SegmentedControl, SendHorizontal, Sparkles, SplitButton, TextArea, Tooltip } from "../../ui-kit";
import "./commit.css";
import { applyExtendedTemplate, createMessageCheck, draftMessage, drafting, generateTooltip } from "./generate";
import { t } from "../../i18n";
import { conventionalHint, subjectOf, SUBJECT_SOFT_LIMIT } from "./logic";
import { ExecSurfaceBanner } from "./ExecSurfaceBanner";
import { MessageHistory } from "./MessageHistory";
import {
  amend,
  invalidFields,
  messageMode,
  repoMessage,
  setMessageMode,
  setSharedMessage,
  SHARED_FIELD,
  sharedMessage,
} from "./messageState";

/** Global shortcuts of the commit tool window: ⌘↵ commit, ⌥⌘↵ commit and push, ⌘⇧K push dialog. */
function useCommitShortcuts(): void {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || !e.metaKey || pushDialogRequest()) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void (e.altKey ? commitAndPush() : commitAll());
    } else if (e.shiftKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openPushDialog();
    }
  };
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));
}

function SubjectMeta() {
  const hint = createMemo(() => conventionalHint(sharedMessage()));
  const length = createMemo(() => subjectOf(sharedMessage()).length);
  const check = createMessageCheck(sharedMessage);
  return (
    <div class="commit-panel__meta">
      <Show when={check()?.ok}>
        <Badge tone="ok" size="sm" icon={Check} title={t("commit.styleOk")}>
          {check()?.header ? t("commit.conventional") : t("commit.valid")}
        </Badge>
      </Show>
      <Show when={hint()}>
        <Tooltip label={[t("commit.suggestion"), ...(check()?.issues.map((i) => i.message) ?? [])].join(" ")}>
          <span class="commit-panel__hint">
            <Icon icon={Info} size={12} />
            <span class="ui-truncate">
              {t("commit.conventionalLabel")} <code class="ui-mono">{hint()}</code>
            </span>
          </span>
        </Tooltip>
      </Show>
      <Show when={length() > 0}>
        <span class="commit-panel__count ui-tnum" data-over={length() > SUBJECT_SOFT_LIMIT ? "" : undefined} title={t("commit.subjectLength")}>
          {length()}
        </span>
      </Show>
    </div>
  );
}

function PerRepoSummary() {
  const rows = createMemo(() => (workspace()?.repos ?? []).filter((r) => checkedFiles(r.id).length > 0));
  const filled = () => rows().filter((r) => repoMessage(r.id).trim()).length;
  return (
    <div class="commit-panel__perrepo">
      <p class="commit-panel__note">{t("commit.perRepoNote")}</p>
      <Show when={rows().length}>
        <ul class="commit-panel__repos" aria-label={t("commit.reposToCommit")}>
          <For each={rows()}>
            {(repo) => {
              const ready = () => !!repoMessage(repo.id).trim();
              return (
                <li class="commit-panel__repo" data-ready={ready() ? "" : undefined} data-invalid={invalidFields().has(repo.id) ? "" : undefined}>
                  <RepoBadge color={repo.color} badge={repo.badge} size={16} />
                  <span class="ui-truncate">{repoName(repo.id)}</span>
                  <span class="commit-panel__repo-state">
                    <Icon icon={ready() ? Check : Info} size={12} />
                    {ready() ? t("commit.msgReady") : t("commit.needsMsg")}
                  </span>
                </li>
              );
            }}
          </For>
        </ul>
        <p class="commit-panel__progress ui-tnum" aria-live="polite">
          {t("commit.progress", { done: filled(), total: rows().length })}
        </p>
      </Show>
    </div>
  );
}

/** The message area of the Commit tool window: message (shared or per repo), Amend, history and the Commit buttons. */
export function CommitPanel() {
  useCommitShortcuts();
  const preview = createMemo(commitPreview);
  const busy = () => activeSheetRun()?.kind === "commit";
  const missing = () => invalidFields().has(SHARED_FIELD);
  const amendBlocked = () => preview().repos > 1;
  const changeCount = () => Object.values(snapshots()).reduce((n, s) => n + s.changes.length, 0);
  // Amending another repository after switching the ticks: its own last message replaces the earlier prefill.
  const ticked = createMemo(() => (workspace()?.repos ?? []).filter((r) => checkedFiles(r.id).length > 0).map((r) => r.id).join(","));
  createEffect(on(ticked, () => void refreshAmendPrefill(), { defer: true }));
  // Amend rewrites HEAD: when nothing is ahead of the remote, that commit is already published.
  const amendPublished = () => {
    if (!amend() || preview().repos !== 1) return false;
    const repo = (workspace()?.repos ?? []).find((r) => checkedFiles(r.id).length > 0);
    return !!repo && snapshots()[repo.id]?.ahead === 0;
  };

  return (
    <section class="commit-panel" aria-label={t("commit.panel")}>
      <header class="commit-panel__head">
        <h3 class="commit-panel__title">{t("commit.messageTitle")}</h3>
        <SegmentedControl
          size="sm"
          aria-label={t("commit.mode")}
          value={messageMode()}
          onChange={setMessageMode}
          options={[
            { value: "shared", label: t("commit.shared") },
            { value: "perRepo", label: t("commit.perRepo") },
          ]}
        />
      </header>

      <Show when={messageMode() === "shared"} fallback={<PerRepoSummary />}>
        <TextArea
          class="commit-panel__field"
          aria-label={t("commit.messageTitle")}
          data-commit-message=""
          placeholder={t("commit.messagePh")}
          minRows={3}
          maxRows={10}
          spellcheck={false}
          value={sharedMessage()}
          invalid={missing()}
          onInput={(e) => setSharedMessage(e.currentTarget.value)}
        />
        <Show when={missing()}>
          <p class="commit-panel__error" role="alert">
            {t("commit.enterMsg")}
          </p>
        </Show>
        <SubjectMeta />
      </Show>

      <div class="commit-panel__tools">
        <Tooltip label={t("commit.amendTip")} disabled={!amendBlocked() || amend()}>
          <Checkbox label={t("commit.amend")} size="sm" checked={amend()} disabled={amendBlocked() && !amend()} onChange={(on) => void setAmendMode(on)} />
        </Tooltip>
        <span class="commit-panel__spacer" />
        <Show when={messageMode() === "shared"}>
          <MessageHistory onPick={setSharedMessage} field={() => document.querySelector<HTMLElement>("textarea[data-commit-message]")} />
        </Show>
        <Show when={messageMode() === "shared"}>
          <IconButton
            icon={FileText}
            label={t("commit.templateLabel")}
            tooltip={t("commit.templateTip")}
            size="sm"
            onClick={() => void applyExtendedTemplate().then(() => document.querySelector<HTMLElement>("textarea[data-commit-message]")?.focus())}
          />
        </Show>
        <IconButton icon={Sparkles} label={t("commit.generate")} tooltip={generateTooltip()} size="sm" loading={drafting()} disabled={preview().repos === 0} onClick={() => void draftMessage()} />
      </div>

      <Show when={amend() && amendBlocked()}>
        <p class="commit-panel__error" role="alert">
          {t("commit.amendError")}
        </p>
      </Show>
      <Show when={amendPublished()}>
        <p class="commit-panel__status">{t("commit.amendPublished")}</p>
      </Show>

      <ExecSurfaceBanner />

      <For each={commitPanelSlots()}>{(slot) => <Dynamic component={slot.component} />}</For>

      <footer class="commit-panel__actions">
        <SplitButton
          size="md"
          icon={GitCommitHorizontal}
          disabled={preview().repos === 0 || preview().conflicts.length > 0}
          loading={busy()}
          menuLabel={t("commit.moreActions")}
          menuPlacement="top-end"
          onClick={() => void commitAll()}
          items={[{ label: t("commit.commitPush"), icon: SendHorizontal, shortcut: ["⌥", "⌘", "↵"], onSelect: () => void commitAndPush() }]}
        >
          {preview().label}
        </SplitButton>
        <Show when={preview().conflicts.length > 0}>
          <p class="commit-panel__error" role="alert">
            {t("commit.conflictsIn", { names: preview().conflicts.map((id) => repoName(id)).join(", ") })}
          </p>
        </Show>
        <Show when={preview().repos === 0}>
          <p class="commit-panel__status">{changeCount() === 0 ? t("commit.noChanges") : t("commit.tickFiles")}</p>
        </Show>
      </footer>
    </section>
  );
}
