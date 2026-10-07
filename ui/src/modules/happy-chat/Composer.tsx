import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack } from "solid-js";
import { Dynamic } from "solid-js/web";
import { fmt, t } from "../../i18n";
import { chatComposerExtensions, collectChatExtras } from "../../platform/chatComposer";
import type { ChatPerson, ChatSendOptions } from "../../ipc/happy";
import { Button, Icon, IconButton, SendHorizontal, TextArea, TriangleAlert } from "../../ui-kit";
import { Avatar } from "./Message";
import { COUNTER_FROM, insertMention, MAX_LENGTH, mentionIds, mentionQuery } from "./logic";
import { chatPrefs } from "../../store/happy";
import { chatSummary, getDraft, notifyTyping, refreshSummary, searchPeople, sendMessage, sendReply, setDraft } from "./state";

/** Up to two decimals; the message formats the number in the language of the UI. */
const credits = (n: number): number => Math.round(n * 100) / 100;

/**
 * Enter sends, Shift+Enter adds a line. Every send spends store credits on the real service, so the cost is always visible
 * and a 402 turns the composer into a banner until the balance is back.
 */
export function Composer(props: { channelId: string; placeholder: string; label?: string; thread?: { rootId: string }; textareaRef?: (el: HTMLTextAreaElement) => void }) {
  /** Drafts are kept per channel and per thread. */
  const draftKey = () => (props.thread ? `${props.channelId}#thread:${props.thread.rootId}` : props.channelId);
  const [text, setText] = createSignal(getDraft(draftKey()));
  const [submitting, setSubmitting] = createSignal(false);
  const [caret, setCaret] = createSignal(0);
  const [people, setPeople] = createSignal<ChatPerson[]>([]);
  const [pick, setPick] = createSignal(0);
  const [dismissed, setDismissed] = createSignal<string>();
  /** Everyone the directory has shown this session: `mentionIds` resolves the @names of the text against them. */
  const seen = new Map<string, ChatPerson>();
  const [block, setBlock] = createSignal<string>();
  const [checking, setChecking] = createSignal(false);
  let area: HTMLTextAreaElement | undefined;

  const summary = chatSummary;
  const empty = () => !!summary()?.creditsEmpty;
  const tooLong = () => text().length > MAX_LENGTH;
  const paused = () => chatPrefs()?.allowActions === false;
  const canSend = () => !!text().trim() && !tooLong() && !empty() && !paused();
  const extensions = chatComposerExtensions;

  // The same instance can be pointed at another conversation: park the draft under the old key, load the new key's own.
  createEffect(
    on(draftKey, (key, prev) => {
      if (prev === undefined) return;
      setDraft(prev, untrack(text));
      setText(getDraft(key));
      setCaret(0);
      setPeople([]);
      setBlock(undefined);
    }),
  );
  onCleanup(() => setDraft(draftKey(), text()));

  // @mention picker: `@` plus letters at the caret asks the directory (debounced) and lists the people.
  const mq = createMemo(() => mentionQuery(text(), caret()));
  const wanted = () => {
    const q = mq();
    return q && q.query.trim().length > 0 && dismissed() !== `${q.start}:${q.query}` ? q : undefined;
  };
  let seq = 0;
  createEffect(
    on(
      () => wanted()?.query,
      (query) => {
        if (query === undefined) return setPeople([]);
        const mine = ++seq;
        const timer = setTimeout(() => {
          searchPeople(query)
            .then((found) => {
              if (mine !== seq) return;
              found.forEach((p) => seen.set(p.id, p));
              setPeople(found.slice(0, 6));
              setPick(0);
            })
            .catch(() => mine === seq && setPeople([]));
        }, 160);
        onCleanup(() => clearTimeout(timer));
      },
    ),
  );
  const listed = () => (wanted() ? people() : []);
  const optionId = (i: number) => `hc-mention-${draftKey().replace(/\W/g, "_")}-${i}`;
  createEffect(() => {
    if (!area) return;
    if (listed().length) area.setAttribute("aria-activedescendant", optionId(pick()));
    else area.removeAttribute("aria-activedescendant");
  });
  const choose = (p: ChatPerson) => {
    const q = mq();
    if (!q) return;
    seen.set(p.id, p);
    const next = insertMention(text(), q, p.name);
    setText(next.text);
    setDraft(draftKey(), next.text);
    setPeople([]);
    queueMicrotask(() => {
      area?.focus();
      area?.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  };

  const submit = async () => {
    if (!canSend() || submitting()) return;
    setSubmitting(true);
    try {
      const body = text();
      const key = draftKey();
      const { extras, block: blocked } = props.thread ? { extras: undefined, block: undefined } : await collectChatExtras(props.channelId);
      if (blocked) return setBlock(blocked);
      setBlock(undefined);
      setText("");
      setDraft(key, "");
      area?.focus();
      const mentions = mentionIds(body, [...seen.values()]);
      if (props.thread) return void (await sendReply(props.channelId, props.thread.rootId, body, mentions));
      const options: ChatSendOptions | undefined = mentions.length ? { ...extras, mentions } : extras;
      const ok = await sendMessage(props.channelId, body, options);
      if (ok) extensions().forEach((e) => e.clear?.(props.channelId));
    } finally {
      setSubmitting(false);
    }
  };

  const costLine = createMemo(() => {
    const s = summary();
    if (!s) return "";
    const left = s.credits != null ? credits(s.credits) : undefined;
    if (s.sendCost != null) return left != null ? t("hc.costLeft", { cost: credits(s.sendCost), left }) : t("hc.cost", { cost: credits(s.sendCost) });
    return left != null ? t("hc.costUnknownLeft", { left }) : t("hc.costUnknown");
  });

  return (
    <div class="hc-composer">
      <Show when={empty()}>
        <div class="hc-banner" data-tone="warn" role="status">
          <Icon icon={TriangleAlert} size={14} />
          <div class="hc-banner__text">
            <strong>{t("hc.credits.title")}</strong>
            <span>{t("hc.credits.body")}</span>
          </div>
          <Button
            size="sm"
            loading={checking()}
            onClick={async () => {
              setChecking(true);
              await refreshSummary(true);
              setChecking(false);
            }}
          >
            {t("hc.check")}
          </Button>
        </div>
      </Show>
      <Show when={paused()}>
        <p class="hc-composer__block" role="status">{t("hc.paused")}</p>
      </Show>
      <Show when={block()}>
        <p class="hc-composer__block" role="alert">{block()}</p>
      </Show>
      <Show when={listed().length > 0}>
        <ul class="hc-mention-list" role="listbox" aria-label={t("hc.cmp.mentionList")}>
          <For each={listed()}>
            {(p, i) => (
              <li
                id={optionId(i())}
                role="option"
                class="hc-mention-list__item"
                aria-selected={i() === pick()}
                data-active={i() === pick() ? "" : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(p)}
              >
                <Avatar name={p.name} size={18} />
                <span class="hc-mention-list__name ui-truncate">{p.name}</span>
                <Show when={p.detail}><span class="hc-mention-list__detail ui-truncate">{p.detail}</span></Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <For each={props.thread ? [] : extensions().filter((e) => e.chips)}>{(e) => <Dynamic component={e.chips} channelId={props.channelId} disabled={empty()} />}</For>
      <div class="hc-composer__row">
        <TextArea
          wrapperClass="hc-composer__field"
          minRows={1}
          maxRows={6}
          value={text()}
          placeholder={props.placeholder}
          aria-label={props.label ?? props.placeholder}
          aria-autocomplete="list"
          invalid={tooLong()}
          spellcheck
          ref={(el) => {
            area = el;
            props.textareaRef?.(el);
          }}
          onInput={(e) => {
            setText(e.currentTarget.value);
            setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
            setDraft(draftKey(), e.currentTarget.value);
            if (e.currentTarget.value.trim() && !props.thread) notifyTyping(props.channelId);
          }}
          onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyUp={(e) => ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) && setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={(e) => {
            const open = listed();
            if (open.length > 0 && !e.isComposing) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                return setPick((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + open.length) % open.length);
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                return choose(open[Math.min(pick(), open.length - 1)]!);
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                const q = mq();
                return setDismissed(q ? `${q.start}:${q.query}` : undefined);
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !e.metaKey && !e.ctrlKey && !e.altKey) {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape" && text()) {
              // Escape leaves the conversation only from an empty composer.
              e.preventDefault();
            }
          }}
        />
        <For each={props.thread ? [] : extensions().filter((e) => e.toolbar)}>{(e) => <Dynamic component={e.toolbar} channelId={props.channelId} disabled={empty()} />}</For>
        <IconButton
          icon={SendHorizontal}
          label={t("hc.send")}
          tooltip={empty() ? t("hc.credits.title") : paused() ? t("hc.sendOff") : t("hc.send")}
          shortcut={["↵"]}
          variant="secondary"
          disabled={!canSend()}
          onClick={() => void submit()}
        />
      </div>
      <div class="hc-composer__meta">
        <span class="hc-composer__cost">{costLine()}</span>
        <Show when={text().length >= COUNTER_FROM}>
          <span class="hc-composer__count ui-tnum" data-over={tooLong() ? "" : undefined} aria-live="polite">
            {fmt.number(text().length)} / {fmt.number(MAX_LENGTH)}
          </span>
        </Show>
      </div>
    </div>
  );
}
