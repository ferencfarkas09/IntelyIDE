import type { LucideIcon } from "lucide-solid";
import { Show, type JSX } from "solid-js";
import { t } from "../../i18n";
import { Button, CircleAlert, EmptyState, RefreshCw, Skeleton } from "../../ui-kit";

/** The loading state every card shares: two quiet bars, no spinner jumping around. */
export function CardLoading() {
  return (
    <div class="dash-loading" aria-busy="true" aria-label={t("dash.loading")}>
      <Skeleton height={28} />
      <Skeleton height={14} width="70%" />
    </div>
  );
}

/** An empty card always says why it is empty, so the person knows whether to do something. */
export function CardEmpty(props: { icon: LucideIcon; title: string; why: string; action?: JSX.Element }) {
  return <EmptyState size="sm" icon={props.icon} title={props.title} description={props.why} action={props.action} class="dash-empty" />;
}

export function CardError(props: { message?: string; onRetry?: () => void }) {
  return (
    <EmptyState
      size="sm"
      tone="danger"
      icon={CircleAlert}
      title={t("dash.error")}
      description={props.message}
      class="dash-empty"
      action={
        <Show when={props.onRetry}>
          {(retry) => (
            <Button size="sm" variant="secondary" icon={RefreshCw} onClick={() => retry()()}>
              {t("dash.retry")}
            </Button>
          )}
        </Show>
      }
    />
  );
}

/** A resource keeps a rejection that is not an Error (an engine error `{ code, message }`) as the `cause` of a generic Error. */
export const causeOf = (e: unknown): unknown => (e instanceof Error && e.cause !== undefined ? e.cause : e);

export const errorText = (raw: unknown): string => errorOf(causeOf(raw));
const errorOf = (e: unknown): string => (e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e));
