import { createSignal, Show } from "solid-js";
import { t } from "../i18n";
import { errorText } from "../store/snapshots";
import { Button, IconButton, Menu, Sparkles, toast, Wrench, CircleQuestionMark } from "../ui-kit";
import { sendErrorToAgent, type ErrorIntent, type ErrorPromptInput } from "../platform/sendToAgent";
import { sendToAgentEnabled } from "../modules/sendtoagent/toggle";

export interface SendToAgentMenuProps {
  /** What to send, read when an item is picked; `undefined` (nothing to send) shows a short note instead. */
  collect: () => Omit<ErrorPromptInput, "intent"> | undefined | Promise<Omit<ErrorPromptInput, "intent"> | undefined>;
  /** `icon`: an icon button for a toolbar; `button`: a labelled small button (an error banner). */
  variant?: "icon" | "button";
  disabled?: boolean;
  class?: string;
}

/** "Fix with agent" and "Explain this error" for any error view: opens the New Run dialog prefilled; nothing runs by itself. Hidden while the extra is off. */
export function SendToAgentMenu(props: SendToAgentMenuProps) {
  const [busy, setBusy] = createSignal(false);
  const go = async (intent: ErrorIntent) => {
    setBusy(true);
    try {
      const input = await props.collect();
      if (!input || !input.text.trim()) return void toast.info(t("toAgent.nothing"), t("toAgent.nothingBody"));
      if (!(await sendErrorToAgent({ ...input, intent }))) toast.warn(t("toAgent.noDialog"));
    } catch (e) {
      toast.error(t("toAgent.failed"), errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Show when={sendToAgentEnabled()}>
      <Menu
        aria-label={t("toAgent.menu")}
        placement="bottom-end"
        items={[
          { label: t("toAgent.fix"), description: t("toAgent.fixDesc"), icon: Wrench, onSelect: () => void go("fix") },
          { label: t("toAgent.explain"), description: t("toAgent.explainDesc"), icon: CircleQuestionMark, onSelect: () => void go("explain") },
        ]}
        trigger={(p) => (
          <Show when={props.variant === "button"} fallback={<IconButton {...p} class={props.class} icon={Sparkles} size="sm" label={t("toAgent.menu")} disabled={props.disabled || busy()} />}>
            <Button {...p} class={props.class} size="sm" variant="secondary" icon={Sparkles} loading={busy()} disabled={props.disabled}>
              {t("toAgent.button")}
            </Button>
          </Show>
        )}
      />
    </Show>
  );
}
