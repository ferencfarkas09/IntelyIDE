import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { openSettings } from "../../platform/settings";
import { Badge, Button, CircleAlert, Input, Kbd, Lock, SendHorizontal, Sparkles, Spinner, X } from "../../ui-kit";
import { openConnectionsTab } from "./gate";
import { AI_EXAMPLES } from "./logic";
import { markPayloadSeen, payloadSeen, type CollectionModel } from "./model";
import { PayloadDialog } from "./PayloadDialog";

export interface AiBarProps {
  m: CollectionModel;
  connectionId: string;
  inputRef?: (el: HTMLInputElement) => void;
}

/** "Ask in plain language": a Hungarian or English question becomes a draft find in the editors, under a review strip. */
export function AiBar(props: AiBarProps) {
  const m = () => props.m;
  const [example, setExample] = createSignal(0);
  const [dialog, setDialog] = createSignal<"view" | "first" | null>(null);
  onMount(() => {
    const t = setInterval(() => setExample((i) => (i + 1) % AI_EXAMPLES.length), 5000);
    onCleanup(() => clearInterval(t));
  });

  const submit = () => {
    if (!m().ai.question().trim() || m().ai.status() === "asking") return;
    if (!payloadSeen(props.connectionId)) return setDialog("first");
    void m().ai.ask();
  };
  const err = () => m().ai.error();

  return (
    <div class="mg-ai" data-off={m().ai.allowed() ? undefined : ""}>
      <div class="mg-ai__row">
        <Input
          ref={props.inputRef}
          size="md"
          wrapperClass="mg-ai__input"
          aria-label={t("mongoLoud.ai.ask")}
          placeholder={m().ai.allowed() ? AI_EXAMPLES[example()] : t("mongoLoud.ai.offPlaceholder")}
          disabled={!m().ai.allowed()}
          value={m().ai.question()}
          onInput={(e) => m().ai.setQuestion(e.currentTarget.value)}
          // Plain Enter asks; Cmd+Shift+Enter is the Run chord and must not ask again.
          onKeyDown={(e) => {
            if (e.key === "Escape" && m().ai.status() === "asking") return (e.preventDefault(), e.stopPropagation(), m().ai.cancelAsk());
            return e.key === "Enter" && !e.isComposing && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && (e.preventDefault(), submit());
          }}
          leading={<Sparkles size={15} class="mg-ai__spark" />}
          trailing={
            <Show when={m().ai.allowed()}>
              <span class="mg-ai__trail">
                <Kbd keys={["⌘", "I"]} />
                <Show
                  when={m().ai.status() === "asking"}
                  fallback={<Button size="sm" variant="primary" icon={SendHorizontal} disabled={!m().ai.question().trim()} onClick={submit}>{t("mongoLoud.ai.send")}</Button>}
                >
                  <Button size="sm" variant="secondary" icon={X} aria-label={t("mongoLoud.ai.cancelAria")} onClick={() => m().ai.cancelAsk()}>{t("mongoLoud.ai.cancel")}</Button>
                </Show>
              </span>
            </Show>
          }
        />
        <span class="mg-ai__chip" title={t("mongoLoud.ai.findTitle")}><Sparkles size={12} /> {t("mongoLoud.query.find")}</span>
        <Show when={!m().ai.allowed()}><Badge size="sm" icon={Lock} title={t("mongoLoud.ai.off")}>{t("mongoLoud.ai.stateOff")}</Badge></Show>
        <Show when={err()?.code === "mongoNoProvider"}><Badge size="sm" tone="warn" icon={CircleAlert} title={err()?.detail}>{t("mongoLoud.ai.stateNoProvider")}</Badge></Show>
        <Show when={m().ai.allowed()}>
          <button type="button" class="mg-link mg-ai__sent" onClick={() => setDialog("view")}>{t("mongoLoud.ai.whatIsSent")}</button>
        </Show>
      </div>
      <p class="mg-ai__hint" role="status" aria-live="polite" data-empty={m().ai.allowed() && m().ai.status() !== "asking" && payloadSeen(props.connectionId) ? "" : undefined}>
        <Show
          when={m().ai.allowed()}
          fallback={
            <>
              <Lock size={12} /> {t("mongoLoud.ai.off")}
              <Button size="sm" variant="ghost" onClick={() => openConnectionsTab()}>{t("mongoLoud.ai.openConnections")}</Button>
            </>
          }
        >
          <Show when={m().ai.status() === "asking"} fallback={<>{payloadSeen(props.connectionId) ? null : t("mongoLoud.ai.firstUse")}</>}>
            <Spinner /> {t("mongoLoud.ai.drafting")}
            <Show when={m().ai.elapsed() >= 5}><span class="ui-tnum">{m().ai.elapsed()} s</span> <span class="ui-text-3">{t("mongoLoud.ai.escCancels")}</span></Show>
          </Show>
        </Show>
      </p>
      <Show when={m().ai.status() === "clarify" && m().ai.clarification()}>
        {(c) => <p class="mg-ai__note" role="status"><CircleAlert size={14} /> <span><strong>{t("mongoLoud.ai.moreDetail")}</strong> {c()}</span></p>}
      </Show>
      <Show when={m().ai.status() === "error" && err()}>
        {(e) => (
          <p class="mg-ai__note" data-tone="danger" role="alert">
            <CircleAlert size={14} />
            <span>
              <strong>{e().title}.</strong> {e().code === "failed" ? `${e().detail || t("mongoLoud.ai.tryRephrase")}` : e().detail}
              <Show when={e().code === "mongoNoProvider"}> <button type="button" class="mg-link" onClick={() => openSettings("providers")}>{t("mongoLoud.ai.openProviders")}</button></Show>
              <Show when={e().code === "mongoModelBusy"}> <Button size="sm" variant="secondary" onClick={() => void m().ai.ask()}>{t("mongoLoud.tab.retry")}</Button></Show>
            </span>
          </p>
        )}
      </Show>
      <Show when={dialog()}>
        {(mode) => (
          <PayloadDialog
            load={() => m().ai.loadPayload()}
            onClose={() => setDialog(null)}
            onAgree={mode() === "first" ? () => (markPayloadSeen(props.connectionId), setDialog(null), void m().ai.ask()) : undefined}
          />
        )}
      </Show>
    </div>
  );
}
