import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import type { AgentView, Throttle } from "../../store/agent-reducer";
import type { PermissionMode } from "../../store/agent-types";
import { Button, Clock, Icon, IconButton, TriangleAlert, X } from "../../ui-kit";
import { t } from "../../i18n";
import { throttleWording } from "./format";
import { MODE_META } from "./modes";
import "./modes.css";

/** Sticky notice above the composer while the provider is rate limiting; counts down once a second. */
export function ThrottleBanner(props: { throttle: Throttle; canStop: boolean; onStop: () => void }) {
  const [now, setNow] = createSignal(Date.now());
  const id = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(id));
  const wording = () => throttleWording(props.throttle, now());
  // Screen readers get the wording re-evaluated once a minute, not the per-second countdown.
  const spoken = createMemo(() => throttleWording(props.throttle, Math.floor(now() / 60_000) * 60_000));
  return (
    <div class="banner" data-tone="warn" role="status">
      <Icon icon={Clock} size={14} />
      <div class="banner__text" aria-hidden="true">
        <div class="banner__title">{wording().title}</div>
        <div class="banner__hint">{wording().hint}</div>
      </div>
      <span class="ui-sr-only">
        {spoken().title}. {spoken().hint}
      </span>
      <Show when={props.canStop}>
        <Button size="sm" variant="secondary" onClick={props.onStop}>
          {t("chat.stopRun")}
        </Button>
      </Show>
    </div>
  );
}

const BANNER_TEXT = { resumeDowngrade: "modes.banner.resumeDowngrade", roleChanged: "modes.banner.roleChanged", providerLimit: "modes.banner.providerLimit" } as const;

/** Said once above a run's transcript when the host changed its mode on its own (a resume dropped Bypass, a role changed, the build switched Automatic off). */
export function ModeBanner(props: { banner: NonNullable<AgentView["banner"]>; mode: PermissionMode; onDismiss: () => void }) {
  return (
    <div class="banner banner--run" data-tone="warn" role="status" data-kind={props.banner.kind}>
      <Icon icon={TriangleAlert} size={14} />
      <div class="banner__text">
        <div class="banner__hint">{t(BANNER_TEXT[props.banner.kind], { mode: t(MODE_META[props.mode].label) })}</div>
      </div>
      <IconButton icon={X} label={t("modes.banner.dismiss")} size="sm" onClick={props.onDismiss} />
    </div>
  );
}
