import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { t } from "../../i18n";
import type { AiMode, Environment, ProfileView } from "../../ipc/mongo";
import { Button, CircleAlert, Copy, Dialog, Input, SegmentedControl, toast, TriangleAlert } from "../../ui-kit";
import { AllowHostsDialog, DiagnosisView, HostKeyDialog, stepLabel, TestStepper } from "./stepper";
import { createFormController, FormContext, secretFieldId } from "./form/controller";
import { Field, StarToggle, TextField, problemText } from "./form/fields";
import { COLORS, DEFAULT_COLOR, fieldId, FORM_TABS, type FormOptions, type FormTab } from "./form/model";
import { AdvancedTab, AiTab, SafetyTab } from "./form/tabsMore";
import { AuthTab, ConnectionTab, TlsTab, TunnelTab } from "./form/tabsConn";
import { profiles } from "./store";
import "./form/form.css";

const colorName = (c: (typeof COLORS)[number]): string => {
  switch (c) {
    case "#4f9d69": return t("mongoForm.color.green");
    case "#d9a441": return t("mongoForm.color.amber");
    case "#e5484d": return t("mongoForm.color.red");
    case "#5b8def": return t("mongoForm.color.blue");
    case "#9b6dd6": return t("mongoForm.color.purple");
    case "#2fb3b3": return t("mongoForm.color.teal");
    default: return t("mongoForm.color.grey");
  }
};

export interface ConnectionFormProps extends Omit<FormOptions, "profile"> {
  /** The profile to edit; undefined creates a new one. */
  profile?: ProfileView;
  /** Default AI mode of a new connection (Settings > Database). */
  defaultAi: AiMode;
  onClose: () => void;
  onSaved?: (p: ProfileView) => void;
  /** Opens on this tab. */
  tab?: FormTab;
}

/**
 * The connection editor (S4): a header (name, colour, tag, group, favourite), seven tabs, the staged test with its diagnosis, the
 * typed confirmation for anything that lowers safety, and a footer with the masked URI. All text goes through `mongoForm`.
 */
export function ConnectionForm(props: ConnectionFormProps) {
  const f = createFormController({ profile: props.profile, defaultAi: props.defaultAi, happyPreset: props.happyPreset, initial: props.initial, tab: props.tab, onClose: props.onClose, onSaved: props.onSaved });
  const [allowDialog, setAllowDialog] = createSignal<string[]>();
  const groups = createMemo(() => [...new Set(profiles().map((p) => p.group).filter((g): g is string => !!g))].sort());
  const tunnelOn = () => f.spec().tunnel?.kind === "ssh";
  const failed = () => f.steps().find((s) => s.state === "failed");
  const diag = () => (f.report() && !f.report()!.ok ? (f.report()!.diagnosis ?? undefined) : undefined);
  const envOptions = (): { value: Environment; label: string }[] => [
    { value: "local", label: t("mongoForm.env.local") },
    { value: "sandbox", label: t("mongoForm.env.sandbox") },
    { value: "production", label: t("mongoForm.env.production") },
  ];
  const tabLabel = (k: FormTab) => t(`mongoForm.tab.${k}`);
  const tabErrors = (k: FormTab) => (f.showErrors() ? f.errors().filter((p) => p.tab === k).length : 0);
  const color = () => f.s.color ?? DEFAULT_COLOR[f.s.environment];

  let testPanel: HTMLElement | undefined;
  // The result is below the tabs. A running test brings its step list into view; a test that ended with a diagnosis brings
  // the diagnosis (its fixes and their button) into view, because that is what the person acts on and the dialog is often
  // shorter than the steps and the diagnosis together; a passed test shows the whole panel.
  createEffect(() => {
    const running = f.testing();
    f.report();
    f.testError();
    queueMicrotask(() => {
      const target = !running && diag() ? (testPanel?.querySelector<HTMLElement>(".mgd") ?? testPanel) : testPanel;
      target?.scrollIntoView?.({ block: "nearest" });
    });
  });

  let tablist: HTMLDivElement | undefined;
  const onTabKey = (e: KeyboardEvent) => {
    const rtl = tablist ? getComputedStyle(tablist).direction === "rtl" : false;
    const i = FORM_TABS.indexOf(f.tab());
    let n = -1;
    if (e.key === (rtl ? "ArrowLeft" : "ArrowRight")) n = (i + 1) % FORM_TABS.length;
    else if (e.key === (rtl ? "ArrowRight" : "ArrowLeft")) n = (i - 1 + FORM_TABS.length) % FORM_TABS.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = FORM_TABS.length - 1;
    if (n < 0) return;
    e.preventDefault();
    f.setTab(FORM_TABS[n]);
    tablist?.querySelector<HTMLElement>(`#mgf-tab-${FORM_TABS[n]}`)?.focus();
  };

  return (
    <FormContext.Provider value={f}>
      <Dialog
        open
        onClose={props.onClose}
        size="xl"
        title={f.old ? t("mongoForm.title.edit", { name: f.old.name }) : t("mongoForm.title.new")}
        description={t("mongoForm.description")}
        footer={
          <div class="mgf-footer">
            <div class="mgf-footer__uri">
              <Show when={f.masked()}>
                <code dir="ltr" class="mgf-footer__code" title={f.masked()} aria-label={t("mongoForm.uri.maskedAria")}>{f.masked()}</code>
                <Button size="sm" variant="ghost" icon={Copy} aria-label={t("mongoForm.uri.copy")} onClick={() => void navigator.clipboard?.writeText(f.masked()).then(() => toast.info(t("mongoForm.copied")))} />
              </Show>
            </div>
            <Button variant="secondary" onClick={() => void f.runTest()} loading={f.testing()} disabled={f.testBlocked() && !f.testing()}>{t("mongoForm.test.button")}</Button>
            <Button variant="ghost" onClick={props.onClose}>{t("mongoForm.cancel")}</Button>
            <Button variant="primary" onClick={() => void f.save()} loading={f.saving()} disabled={f.saving()}>{t("mongoForm.save")}</Button>
          </div>
        }
      >
        <div class="mgf">
          <header class="mgf-head">
            <div class="mgf-head__name">
              <TextField path="name" label={t("mongoForm.name.label")} placeholder={t("mongoForm.name.placeholder")} value={f.s.name} onInput={(v) => f.setS("name", v)} autofocus />
              <StarToggle on={f.s.favorite} onChange={(v) => f.setS("favorite", v)} label={f.s.favorite ? t("mongoForm.favorite.on") : t("mongoForm.favorite.off")} />
            </div>
            <div class="mgf-head__row">
              <Field label={t("mongoForm.env.label")}>
                {() => <SegmentedControl aria-label={t("mongoForm.env.label")} size="sm" value={f.s.environment} onChange={f.setEnvironment} options={envOptions()} />}
              </Field>
              <Field label={t("mongoForm.group.label")}>
                {(a) => (
                  <>
                    <Input id={a.id} list="mgf-groups" maxlength={40} autocomplete="off" placeholder={t("mongoForm.group.placeholder")} value={f.s.group} onInput={(e) => f.setS("group", e.currentTarget.value.slice(0, 40))} />
                    <datalist id="mgf-groups"><For each={groups()}>{(g) => <option value={g} />}</For></datalist>
                  </>
                )}
              </Field>
              <Field label={t("mongoForm.color.label")}>
                {() => (
                  <div class="mgf-swatches" role="radiogroup" aria-label={t("mongoForm.color.label")}>
                    <For each={COLORS}>
                      {(c) => <button type="button" role="radio" aria-checked={color() === c} aria-label={colorName(c)} class="mgf-swatch" style={{ "--c": c }} onClick={() => f.setS("color", c)} />}
                    </For>
                  </div>
                )}
              </Field>
            </div>
          </header>

          <Show when={f.showErrors() && f.errors().length}>
            <section class="mgf-summary" role="alert" aria-label={t("mongoForm.summary.title", { count: f.errors().length })}>
              <p><TriangleAlert size={14} aria-hidden="true" /> <strong>{t("mongoForm.summary.title", { count: f.errors().length })}</strong></p>
              <ul>
                <For each={f.errors()}>
                  {(p) => (
                    <li>
                      <button type="button" class="mgf-link" onClick={() => f.goto(p.tab === "header" ? f.tab() : p.tab, fieldId(p.path))}>
                        {p.tab === "header" ? t("mongoForm.tab.header") : tabLabel(p.tab)}: {problemText(p)}
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>
          <Show when={f.saveError()}><p class="mgf-danger" role="alert"><CircleAlert size={14} aria-hidden="true" /> {f.saveError()}</p></Show>

          <div class="mgf-tabs" role="tablist" aria-label={t("mongoForm.tabs.label")} ref={tablist} onKeyDown={onTabKey}>
            <For each={FORM_TABS}>
              {(k) => (
                <button type="button" role="tab" id={`mgf-tab-${k}`} aria-selected={f.tab() === k} aria-controls={`mgf-panel-${k}`} tabindex={f.tab() === k ? 0 : -1} class="mgf-tab" onClick={() => f.setTab(k)}>
                  {tabLabel(k)}
                  <Show when={tabErrors(k)}><span class="mgf-tab__n" aria-label={t("mongoForm.tab.problems", { count: tabErrors(k) })}>{tabErrors(k)}</span></Show>
                </button>
              )}
            </For>
          </div>
          {/* Every panel stays mounted (hidden): what was typed must survive a tab change, and the error summary can focus any field. */}
          <div role="tabpanel" id="mgf-panel-connection" aria-labelledby="mgf-tab-connection" hidden={f.tab() !== "connection"} class="mgf-panel"><ConnectionTab /></div>
          <div role="tabpanel" id="mgf-panel-auth" aria-labelledby="mgf-tab-auth" hidden={f.tab() !== "auth"} class="mgf-panel"><AuthTab /></div>
          <div role="tabpanel" id="mgf-panel-tls" aria-labelledby="mgf-tab-tls" hidden={f.tab() !== "tls"} class="mgf-panel"><TlsTab /></div>
          <div role="tabpanel" id="mgf-panel-tunnel" aria-labelledby="mgf-tab-tunnel" hidden={f.tab() !== "tunnel"} class="mgf-panel"><TunnelTab /></div>
          <div role="tabpanel" id="mgf-panel-advanced" aria-labelledby="mgf-tab-advanced" hidden={f.tab() !== "advanced"} class="mgf-panel"><AdvancedTab /></div>
          <div role="tabpanel" id="mgf-panel-safety" aria-labelledby="mgf-tab-safety" hidden={f.tab() !== "safety"} class="mgf-panel"><SafetyTab /></div>
          <div role="tabpanel" id="mgf-panel-ai" aria-labelledby="mgf-tab-ai" hidden={f.tab() !== "ai"} class="mgf-panel"><AiTab happyPreset={props.happyPreset} /></div>

          <Show when={f.lowering().length}>
            <section class="mgf-confirm">
              <label for="mgf-confirm"><strong>{t("mongoForm.confirm.title")}</strong> {t("mongoForm.confirm.body", { name: f.s.name.trim() || "…" })}</label>
              <ul>
                <For each={f.lowering()}>{(r) => <li>{t(`mongoForm.confirm.reason.${r}`)}</li>}</For>
              </ul>
              <Input id="mgf-confirm" aria-label={t("mongoForm.confirm.aria")} autocomplete="off" spellcheck={false} value={f.s.confirm} invalid={!!f.s.confirm && !f.isConfirmed()} onInput={(e) => f.setS("confirm", e.currentTarget.value)} />
            </section>
          </Show>

          <Show when={f.testing() || f.report() || f.testError()}>
            <section class="mgf-test" aria-label={t("mongoForm.test.title")} ref={testPanel}>
              <Show when={f.testError()}><p class="mgf-danger" role="alert"><CircleAlert size={14} aria-hidden="true" /> {f.testError()}</p></Show>
              <Show when={f.testing() || f.steps().length || f.report()}>
                <TestStepper
                  tunnel={tunnelOn()}
                  running={f.testing()}
                  cancelled={f.cancelled()}
                  steps={f.steps()}
                  report={f.report()}
                  onCancel={() => void f.cancelTest()}
                  unallowedMembers={f.unallowedMembers()}
                  onAllowMembers={(hosts) => setAllowDialog(hosts)}
                >
                  <Show when={diag()}>
                    {(d) => (
                      <DiagnosisView
                        diagnosis={d()}
                        failedStep={failed() ? stepLabel(failed()!.id) : undefined}
                        onRetry={() => void f.runTest()}
                        onReviewHostKey={() => (f.report()?.hostKey ? f.setHostKey({ view: f.report()!.hostKey!, host: f.report()!.hostKey!.host }) : void f.checkHostKey())}
                        onAllowHost={(h) => setAllowDialog([h])}
                        onEnterSecret={() => f.goto("auth", secretFieldId("password"))}
                      />
                    )}
                  </Show>
                </TestStepper>
              </Show>
            </section>
          </Show>
        </div>
      </Dialog>

      <HostKeyDialog
        open={!!f.hostKey()}
        view={f.hostKey()?.view}
        unscannable={f.hostKey()?.unscannable}
        host={f.hostKey()?.host}
        expectedFingerprint={f.hostKey()?.expected}
        onTrust={(v) => f.trustHostKey(v)}
        onForget={(typed) => f.forgetHostKey(typed)}
        onClose={() => f.setHostKey(undefined)}
      />
      <AllowHostsDialog
        open={!!allowDialog()}
        hosts={allowDialog() ?? []}
        onConfirm={(hosts) => {
          f.allowHosts(hosts);
          setAllowDialog(undefined);
          toast.info(t("mongoForm.allowed.added", { count: hosts.length }));
        }}
        onClose={() => setAllowDialog(undefined)}
      />
    </FormContext.Provider>
  );
}
