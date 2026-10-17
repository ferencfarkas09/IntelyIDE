import { createSignal, onCleanup, Show } from "solid-js";
import { fmt, t } from "../../i18n";
import { ProviderMark } from "../../modules/providers/ProviderMark";
import { roleColor } from "../../modules/runs/roleColors";
import { Bot, Check, Copy, Icon, IconButton } from "../../ui-kit";

/** Events carry a real clock in milliseconds; anything smaller is a replayed or synthetic stamp and says nothing to a reader. */
const FIRST_REAL_MS = 100_000_000_000;

/** "14:32" for a message of today, "Oct 16, 14:32" for an older one; empty when the stamp is not a real time. */
export function clock(ts: number, now: number = Date.now()): string {
  if (!(ts >= FIRST_REAL_MS)) return "";
  const when = new Date(ts);
  const today = new Date(now);
  const sameDay = when.getFullYear() === today.getFullYear() && when.getMonth() === today.getMonth() && when.getDate() === today.getDate();
  return sameDay ? fmt.time(when) : `${fmt.date(when, "medium")}, ${fmt.time(when)}`;
}

/** Who speaks: the provider's mark in a ring of the role's colour. Shown once per run of agent messages. */
export function AgentAvatar(props: { provider?: string; role?: string }) {
  return (
    <span class="avatar" style={{ "--avatar-ring": (props.role && roleColor(props.role)) || "var(--border-strong)" }} aria-hidden="true">
      <Show when={props.provider} fallback={<Icon icon={Bot} size={16} />}>
        {(id) => <ProviderMark id={id()} size={20} />}
      </Show>
    </span>
  );
}

/** The name and the time above the first message of a run of messages. */
export function MessageMeta(props: { name?: string; time: number; align?: "end" }) {
  const when = () => clock(props.time);
  return (
    <Show when={props.name || when()}>
      <div class="msg__meta" data-align={props.align}>
        <Show when={props.name}>
          <span class="msg__name">{props.name}</span>
        </Show>
        <Show when={when()}>
          <time class="msg__time ui-tnum" dateTime={new Date(props.time).toISOString()}>
            {when()}
          </time>
        </Show>
      </div>
    </Show>
  );
}

/** Copies the text of a message; appears when the message is hovered or focused. */
export function CopyButton(props: { text: () => string }) {
  const [copied, setCopied] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.text());
    } catch {
      return; // no clipboard (a locked-down webview): nothing to confirm
    }
    setCopied(true);
    clearTimeout(timer);
    timer = setTimeout(() => setCopied(false), 1600);
  };
  return <IconButton class="msg__copy" size="sm" icon={copied() ? Check : Copy} label={copied() ? t("chat.copied") : t("chat.copy")} tooltipPlacement="left" onClick={() => void copy()} />;
}
