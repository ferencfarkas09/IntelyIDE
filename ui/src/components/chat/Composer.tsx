import { createEffect, createSignal, createUniqueId, For, on, onCleanup, Show } from "solid-js";
import { openSettings } from "../../platform/settings";
import { agentDraft, agentRow, searchRepoFiles, setAgentDraft } from "../../store/agents";
import { requestChip } from "../../store/chatCommands";
import { repoConfig } from "../../store/workspace";
import type { AgentAttachment } from "../../store/agent-types";
import { Button, Kbd, RepoBadge, SendHorizontal, Square, TextArea, Tooltip } from "../../ui-kit";
import { activeMention, applyMention, liveAttachments } from "./mentions";
import { AttachButton, AttachmentChips } from "../../modules/attachments/Chips";
import { createComposerAttachments, type AttachmentsCap } from "../../modules/attachments/composer";
import type { FileSelection } from "../../modules/attachments/types";
import { t } from "../../i18n";
import { CLI_DESCRIPTION, ideCommandOf, IDE_DESCRIPTION, slashEntries, slashQuery, type IdeCommand, type SlashEntry } from "./slash";

interface Candidate {
  repoId: string;
  path: string;
}

const DEBOUNCE_MS = 120;

export interface ComposerProps {
  agentId: string;
  repoIds: string[];
  running: boolean;
  stopping: boolean;
  /** Why sending is not possible right now (shown as the placeholder). */
  blockedReason?: string;
  /** Provider id and its attachment capability: a provider without support refuses drops and pastes. */
  provider?: string;
  attachmentsCap?: AttachmentsCap | null;
  /** The CLI's own slash commands of this run (names without the slash); they are listed after the IDE commands and sent as the message text. */
  slashCommands?: string[];
  onSend: (text: string, attachments: AgentAttachment[], files?: FileSelection) => void;
  onStop: () => void;
}

export function Composer(props: ComposerProps) {
  const listId = createUniqueId();
  let area!: HTMLTextAreaElement;
  const [caret, setCaret] = createSignal(0);
  const [candidates, setCandidates] = createSignal<Candidate[]>([]);
  const [cursor, setCursor] = createSignal(0);
  const [dismissed, setDismissed] = createSignal(false);
  const [attachments, setAttachments] = createSignal<AgentAttachment[]>([]);
  const text = () => agentDraft(props.agentId);
  let rootEl: HTMLDivElement | undefined;
  const att = createComposerAttachments({ key: `agent:${props.agentId}`, get label() { return t("attach.composerLabel"); }, provider: () => props.provider, caps: () => props.attachmentsCap, root: () => rootEl });

  const mention = () => (dismissed() ? null : activeMention(text(), caret()));
  const popupOpen = () => mention() !== null && candidates().length > 0;
  // Slash menu: only while the whole text is still one command word (`/`, `/mc`).
  const [slashDismissed, setSlashDismissed] = createSignal(false);
  const [slashCursor, setSlashCursor] = createSignal(0);
  const slashList = (): SlashEntry[] => {
    const q = slashQuery(text());
    return q === null ? [] : slashEntries(q, props.slashCommands);
  };
  const slashOpen = () => !slashDismissed() && slashList().length > 0;
  createEffect(on(() => slashQuery(text()), () => setSlashCursor(0)));
  const listOpen = () => popupOpen() || slashOpen();
  // Briefly replaces the shortcut hint when a key did nothing, so a swallowed Cmd+Return is not silent.
  const [notice, setNotice] = createSignal<string>();
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const flash = (message: string) => {
    setNotice(message);
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => setNotice(undefined), 2500);
  };

  // Candidates for the mention under the caret, debounced and ignoring stale answers.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ticket = 0;
  createEffect(
    on(
      () => mention()?.query,
      (query) => {
        clearTimeout(timer);
        if (query === undefined) return setCandidates([]);
        const mine = ++ticket;
        timer = setTimeout(async () => {
          const found = await Promise.all(props.repoIds.map(async (repoId) => (await searchRepoFiles(repoId, query, 6)).map((path) => ({ repoId, path }))));
          if (mine === ticket) {
            setCandidates(found.flat().slice(0, 8));
            setCursor(0);
          }
        }, DEBOUNCE_MS);
      },
    ),
  );
  onCleanup(() => (clearTimeout(timer), clearTimeout(noticeTimer)));

  const hasFiles = () => att.store.selection().ids.length > 0 || att.store.folderRefs().length > 0;
  /** The IDE's own commands: handled here, never sent to the model. */
  const runIde = (cmd: IdeCommand) => {
    const row = agentRow(props.agentId);
    if (cmd === "mcp") {
      if (row?.mcpServers?.length) requestChip(props.agentId, "mcp");
      else openSettings("mcp");
    } else if (cmd === "agents") openSettings("roles");
    else if (row?.switchableModes?.length) requestChip(props.agentId, "mode");
    else flash(t("slash.mode.unavailable"));
  };
  const acceptSlash = (entry: SlashEntry) => {
    setSlashDismissed(false);
    if (entry.kind === "ide") {
      setAgentDraft(props.agentId, "");
      setCaret(0);
      runIde(entry.name as IdeCommand);
      return;
    }
    const next = `/${entry.name} `;
    setAgentDraft(props.agentId, next);
    setCaret(next.length);
    queueMicrotask(() => {
      area.focus();
      area.setSelectionRange(next.length, next.length);
    });
  };

  const canSend = () => !props.running && !props.blockedReason && (text().trim() !== "" || hasFiles()) && !att.store.blocker();
  const send = () => {
    // `/mcp` typed out and sent (Cmd+Return) runs the command instead of becoming a message
    const ide = ideCommandOf(text().trim());
    if (ide) {
      setAgentDraft(props.agentId, "");
      return runIde(ide);
    }
    if (!canSend()) return;
    const folders = att.store.folderRefs().filter((f) => f.repoId).map((f) => ({ repoId: f.repoId!, path: f.relPath ?? "" }));
    const sel = att.store.selection();
    const mentions = [...liveAttachments(text(), attachments()), ...folders];
    if (sel.ids.length) props.onSend(text().trim(), mentions, sel);
    else props.onSend(text().trim(), mentions);
    setAgentDraft(props.agentId, "");
    setAttachments([]);
    att.store.rotate();
  };

  const pick = (c: Candidate) => {
    const m = mention();
    if (!m) return;
    const next = applyMention(text(), m, caret(), c.path);
    setAgentDraft(props.agentId, next.text);
    setAttachments((a) => [...a.filter((x) => x.path !== c.path), { repoId: c.repoId, path: c.path }]);
    setCandidates([]);
    queueMicrotask(() => {
      area.focus();
      area.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (props.running && text().trim() !== "") flash(t("chat.stopToSend"));
      return send();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "." && props.running) {
      e.preventDefault();
      return props.onStop();
    }
    if (slashOpen()) {
      const entries = slashList();
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        return setSlashDismissed(true);
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        return setSlashCursor((c) => (c + (e.key === "ArrowDown" ? 1 : entries.length - 1)) % entries.length);
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        return acceptSlash(entries[Math.min(slashCursor(), entries.length - 1)]);
      }
    }
    if (!popupOpen()) return;
    const list = candidates();
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setDismissed(true);
    } else if (list.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => (c + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(list[cursor()]);
      }
    }
  };

  return (
    <div class="composer" ref={(el) => (rootEl = el)} data-testid="composer">
      <Show when={popupOpen()}>
        <div class="composer__pop" id={listId} role="listbox" aria-label={t("chat.files")}>
          <For each={candidates()}>
            {(c, i) => (
              <div id={`${listId}-${i()}`} class="composer__opt" role="option" aria-selected={i() === cursor()} data-active={i() === cursor() ? "" : undefined} onPointerDown={(e) => (e.preventDefault(), pick(c))} onPointerMove={() => setCursor(i())}>
                <Show when={repoConfig(c.repoId)}>{(r) => <RepoBadge color={r().color} badge={r().badge} size={16} title={r().name} />}</Show>
                <span class="ui-mono ui-truncate">{c.path}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={slashOpen()}>
        <div class="composer__pop composer__pop--slash" id={`${listId}-slash`} role="listbox" aria-label={t("slash.menu")} data-testid="slash-menu">
          <For each={slashList()}>
            {(entry, i) => (
              <div
                id={`${listId}-s${i()}`}
                class="composer__opt composer__opt--slash"
                role="option"
                aria-selected={i() === slashCursor()}
                data-active={i() === slashCursor() ? "" : undefined}
                data-kind={entry.kind}
                onPointerDown={(e) => (e.preventDefault(), acceptSlash(entry))}
                onPointerMove={() => setSlashCursor(i())}
                ref={(el) => createEffect(() => i() === slashCursor() && el.scrollIntoView?.({ block: "nearest" }))}
              >
                <span class="composer__cmd ui-mono">/{entry.name}</span>
                <span class="composer__desc ui-truncate">
                  {entry.kind === "ide" ? t(IDE_DESCRIPTION[entry.name as IdeCommand]) : CLI_DESCRIPTION[entry.name] ? t(CLI_DESCRIPTION[entry.name]) : ""}
                </span>
                <span class="composer__tag">{entry.kind === "ide" ? t("slash.tag.ide") : t("slash.tag.cli")}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
      <AttachmentChips items={att.store.items()} provider={att.provider()} onRemove={(id) => void att.store.remove(id)} onConfirm={(id) => void att.store.confirm(id)} />
      <TextArea
        ref={(el) => (area = el)}
        class="composer__field"
        aria-label={t("chat.messageTo")}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={listOpen()}
        aria-autocomplete="list"
        aria-controls={slashOpen() ? `${listId}-slash` : popupOpen() ? listId : undefined}
        aria-activedescendant={slashOpen() ? `${listId}-s${slashCursor()}` : popupOpen() ? `${listId}-${cursor()}` : undefined}
        placeholder={props.blockedReason ?? (props.running ? t("chat.placeholderBusy") : t("chat.placeholder"))}
        minRows={2}
        maxRows={8}
        value={text()}
        disabled={false}
        onInput={(e) => {
          setAgentDraft(props.agentId, e.currentTarget.value);
          setCaret(e.currentTarget.selectionStart);
          setDismissed(false);
          setSlashDismissed(false);
        }}
        onKeyDown={onKeyDown}
        onPaste={att.onPaste}
        onKeyUp={(e) => (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") && setCaret(e.currentTarget.selectionStart)}
        onClick={(e) => setCaret(e.currentTarget.selectionStart)}
      />
      <div class="composer__bar">
        <AttachButton onFiles={att.pick} disabled={props.attachmentsCap === "none"} reason={props.attachmentsCap === "none" ? t("chat.noAttachments", { provider: att.provider() }) : undefined} />
        <span class="composer__hint" role={notice() ? "status" : undefined}>
          <Show when={notice()} fallback={<><Kbd keys={["⌘", "⏎"]} /> {t("chat.sendHint")}</>}>
            {(n) => n()}
          </Show>
        </span>
        <span class="composer__grow" />
        <Show
          when={props.running}
          fallback={
            <Tooltip label={props.blockedReason ?? t("chat.sendMessage")} shortcut={["⌘", "⏎"]}>
              <Button size="sm" variant="primary" icon={SendHorizontal} aria-disabled={!canSend()} onClick={send}>
                {t("chat.send")}
              </Button>
            </Tooltip>
          }
        >
          <Tooltip label={t("chat.stopTheRun")} shortcut={["⌘", "."]}>
            <Button size="sm" variant="danger" icon={Square} loading={props.stopping} onClick={props.onStop}>
              {t("chat.stop")}
            </Button>
          </Tooltip>
        </Show>
      </div>
    </div>
  );
}
