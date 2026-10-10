import { createSignal, For, Show } from "solid-js";
import { t } from "../../i18n";
import type { ServerView, SetupOptions, SetupStepName } from "../../ipc/servers";
import { Button, Checkbox, CircleAlert, CircleCheck, Icon, Info, Minus, Spinner, VisuallyHidden } from "../../ui-kit";
import { defaultSetupOptions, setupOutcome, stepRows } from "./logic";
import { clearSetup, runSetup, setupOf } from "./store";

const STATE_ICON = { done: CircleCheck, failed: CircleAlert, skipped: Minus, info: Info } as const;
const stepName = (s: SetupStepName) => t(`servers.step.${s}` as const);

/** Installs what the server lacks: four choices, a Start button, and the steps as the backend reports them. */
export function SetupPanel(props: { view: ServerView }) {
  const id = () => props.view.cfg.id;
  const [opts, setOpts] = createSignal<SetupOptions>(defaultSetupOptions(props.view.status));
  const run = () => setupOf(id());
  const rows = () => stepRows(run()?.events ?? []);
  const outcome = () => setupOutcome(run()?.events ?? [], run()?.running ?? false, run()?.error);
  const busy = () => run()?.running === true;
  const set = (key: keyof SetupOptions) => (value: boolean) => setOpts({ ...opts(), [key]: value });
  const start = () => {
    clearSetup(id());
    void runSetup(id(), opts());
  };
  const failure = () => {
    const o = outcome();
    return o.phase === "failed" ? o : undefined;
  };
  return (
    <section class="srv-panel" aria-label={t("servers.setup.title", { name: props.view.cfg.name })}>
      <h5 class="srv-panel__title">{t("servers.setup.title", { name: props.view.cfg.name })}</h5>
      <fieldset class="srv-panel__opts" disabled={busy()}>
        <legend>{t("servers.setup.install")}</legend>
        <Checkbox size="sm" checked={opts().installNode} onChange={set("installNode")} label={t("servers.setup.node")} />
        <Checkbox size="sm" checked={opts().installBundle} onChange={set("installBundle")} label={t("servers.setup.bundle")} />
        <Checkbox size="sm" checked={opts().installSdk} onChange={set("installSdk")} label={t("servers.setup.sdk")} />
        <Checkbox size="sm" checked={opts().installClaude} onChange={set("installClaude")} label={t("servers.setup.claude")} />
      </fieldset>
      <div class="srv-actions">
        <Button size="sm" variant="primary" loading={busy()} onClick={start}>
          {t("servers.setup.start")}
        </Button>
      </div>
      <Show when={rows().length > 0}>
        <ol class="srv-steps" aria-label={t("servers.setup.steps")}>
          <For each={rows()}>
            {(r) => (
              <li class="srv-step" data-state={r.state} data-step={r.step}>
                <span class="srv-step__icon">
                  <Show when={r.state === "started"} fallback={<Icon icon={STATE_ICON[r.state as keyof typeof STATE_ICON]} size={14} />}>
                    <Spinner size={14} />
                  </Show>
                </span>
                <span class="srv-step__name">
                  {stepName(r.step)}
                  <VisuallyHidden> {t(`servers.stepState.${r.state}` as const)}</VisuallyHidden>
                </span>
                <ul class="srv-step__lines">
                  <For each={r.lines}>{(l) => <li>{l}</li>}</For>
                </ul>
              </li>
            )}
          </For>
        </ol>
      </Show>
      <Show when={outcome().phase === "ok"}>
        <p class="srv-result" data-tone="ok" role="status">{t("servers.setup.ok")}</p>
      </Show>
      <Show when={failure()}>
        {(f) => (
          <p class="srv-result" data-tone="danger" role="alert">
            {t("servers.setup.failed", { step: stepName(f().step), message: f().message })}
          </p>
        )}
      </Show>
    </section>
  );
}
