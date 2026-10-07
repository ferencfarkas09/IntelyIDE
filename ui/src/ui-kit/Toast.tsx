import { createSignal, For, onCleanup, Show } from "solid-js";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "./icons";
import { Icon } from "./Icon";
import { t } from "../i18n";
import { IconButton } from "./IconButton";
import { Button } from "./Button";

export type ToastTone = "neutral" | "ok" | "warn" | "danger" | "info";

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** ms before auto-dismiss; 0 keeps it until dismissed. Default 5000 (8000 for danger). */
  duration?: number;
  action?: { label: string; onSelect: () => void };
}

interface ToastItemState extends ToastOptions {
  id: number;
  closing: boolean;
}

const ICONS = { neutral: Info, info: Info, ok: CircleCheck, warn: TriangleAlert, danger: CircleAlert };
const EXIT_MS = 160;

export function createToaster() {
  const [toasts, setToasts] = createSignal<ToastItemState[]>([]);
  let seq = 0;
  const dismiss = (id: number) => {
    setToasts((l) => l.map((t) => (t.id === id ? { ...t, closing: true } : t)));
    setTimeout(() => setToasts((l) => l.filter((t) => t.id !== id)), EXIT_MS);
  };
  const show = (opts: ToastOptions) => {
    const id = ++seq;
    setToasts((l) => [...l.slice(-4), { ...opts, id, closing: false }]);
    return id;
  };
  return {
    toasts,
    show,
    dismiss,
    info: (title: string, description?: string) => show({ title, description, tone: "info" }),
    success: (title: string, description?: string) => show({ title, description, tone: "ok" }),
    warn: (title: string, description?: string) => show({ title, description, tone: "warn" }),
    error: (title: string, description?: string) => show({ title, description, tone: "danger" }),
    clear: () => toasts().forEach((t) => dismiss(t.id)),
  };
}

export type Toaster = ReturnType<typeof createToaster>;

/** App-wide toaster. */
export const toast = createToaster();

function ToastItem(props: { item: ToastItemState; toaster: Toaster }) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let remaining = props.item.duration ?? (props.item.tone === "danger" ? 8000 : 5000);
  let startedAt = 0;
  const start = () => {
    if (remaining <= 0) return;
    clearTimeout(timer);
    startedAt = Date.now();
    timer = setTimeout(() => props.toaster.dismiss(props.item.id), remaining);
  };
  const pause = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
    remaining -= Date.now() - startedAt;
  };
  start();
  onCleanup(() => clearTimeout(timer));
  const tone = () => props.item.tone ?? "neutral";
  return (
    <div
      class="ui-toast"
      data-tone={tone()}
      data-state={props.item.closing ? "closed" : "open"}
      role={tone() === "danger" ? "alert" : "status"}
      onPointerEnter={pause}
      onPointerLeave={start}
      onFocusIn={pause}
      onFocusOut={start}
    >
      <span class="ui-toast__icon">
        <Icon icon={ICONS[tone()]} size={16} />
      </span>
      <div class="ui-toast__text">
        <div class="ui-toast__title">{props.item.title}</div>
        <Show when={props.item.description}>
          <div class="ui-toast__desc">{props.item.description}</div>
        </Show>
        <Show when={props.item.action}>
          {(a) => (
            <div class="ui-toast__action">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  a().onSelect();
                  props.toaster.dismiss(props.item.id);
                }}
              >
                {a().label}
              </Button>
            </div>
          )}
        </Show>
      </div>
      <IconButton icon={X} label={t("kit.dismiss")} size="sm" tooltip={t("kit.dismiss")} onClick={() => props.toaster.dismiss(props.item.id)} />
    </div>
  );
}

export function Toaster(props: { toaster?: Toaster; placement?: "bottom-right" | "bottom-left" | "top-right" }) {
  const tz = () => props.toaster ?? toast;
  return (
    <div class="ui-toaster" data-placement={props.placement ?? "bottom-right"} role="region" aria-label={t("kit.notifications")}>
      <For each={tz().toasts()}>{(item) => <ToastItem item={item} toaster={tz()} />}</For>
    </div>
  );
}
