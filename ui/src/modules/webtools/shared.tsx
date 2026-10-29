import { createSignal, onCleanup, type JSX } from "solid-js";
import { t } from "../../i18n";
import { requestNewRun } from "../../platform/newRun";
import { execute } from "../../platform/commands";
import { errorText } from "../../store/snapshots";
import { Badge, Button, Sparkles, toast } from "../../ui-kit";
import type { Confidence } from "./types";

/** A load that can be repeated: `data`, `error`, `loading`, and `run()`. A late answer of an older run is dropped. */
export function createLoad<T>(fn: () => Promise<T>) {
  const [data, setData] = createSignal<T>();
  const [error, setError] = createSignal<string>();
  const [loading, setLoading] = createSignal(false);
  let seq = 0;
  let alive = true;
  onCleanup(() => (alive = false));
  async function run(): Promise<void> {
    const mine = ++seq;
    setLoading(true);
    try {
      const v = await fn();
      if (alive && mine === seq) (setData(() => v), setError(undefined));
    } catch (e) {
      if (alive && mine === seq) setError(errorText(e));
    } finally {
      if (alive && mine === seq) setLoading(false);
    }
  }
  return { data, error, loading, run };
}

/** "Ask agent to ...": fills the New Run dialog with a precise prompt for this repository; nothing runs until the person starts it. */
export function AskButton(props: { repoId: string; prompt: () => string; label?: string; aria: string; size?: "sm" | "md"; variant?: "secondary" | "ghost" }): JSX.Element {
  const ask = async () => {
    const ok = await requestNewRun({ prompt: props.prompt(), repoIds: [props.repoId] });
    if (!ok) toast.warn(t("webtools.ask.unavailable"));
  };
  return (
    <Button size={props.size ?? "sm"} variant={props.variant ?? "secondary"} icon={Sparkles} aria-label={props.aria} onClick={() => void ask()}>
      {props.label ?? t("webtools.ask.fix")}
    </Button>
  );
}

const TONE = { high: "ok", medium: "warn", low: "danger" } as const;
export function ConfBadge(props: { value: Confidence }): JSX.Element {
  return (
    <Badge size="sm" tone={TONE[props.value]} title={t("webtools.conf.tip")}>
      {t(`webtools.conf.${props.value}`)}
    </Badge>
  );
}

/** A file:line that opens in the editor. */
export function FileLink(props: { repoId: string; path: string; line?: number; class?: string }): JSX.Element {
  return (
    <button type="button" class={props.class ? `wt__link ${props.class}` : "wt__link"} title={t("webtools.openFile")} onClick={() => void execute("editor.openFile", { repoId: props.repoId, path: props.path, line: props.line ?? 1, column: 1 })}>
      {props.path}
      {props.line ? `:${props.line}` : ""}
    </button>
  );
}

/** A swatch background is only ever painted from a value that is a plain colour. */
export const SAFE_SWATCH = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([0-9a-z.,%/ -]{1,50}\))$/i;
export function Swatch(props: { value: string | null | undefined; name: string }): JSX.Element {
  return props.value && SAFE_SWATCH.test(props.value) ? <span class="wt__swatch" role="img" aria-label={`${props.name} ${props.value}`} style={{ background: props.value }} /> : <span class="wt__swatch wt__swatch--none" aria-hidden="true" />;
}
