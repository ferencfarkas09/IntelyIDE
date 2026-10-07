import { createSignal, For, onMount, Show } from "solid-js";
import { t } from "../../../i18n";
import type { ConnSpec, LocalHit, ProfileView } from "../../../ipc/mongo";
import { Braces, Button, CircleAlert, CircleCheck, CloudDownload, Copy, Dialog, Input, KeyRound, Laptop, SegmentedControl, Server, toast, TriangleAlert, type LucideIcon } from "../../../ui-kit";
import { createFormController, FormContext, secretFieldId, type FormController } from "../form/controller";
import { TextField, StarToggle, problemText } from "../form/fields";
import { fieldId, type FormTab } from "../form/model";
import { AdvancedTab, SafetyTab } from "../form/tabsMore";
import { AuthTab, ConnectionTab, TlsTab, TunnelTab } from "../form/tabsConn";
import { readOnlyUserCommand, startingSpec, type StartingPoint } from "../logic";
import { AllowHostsDialog, DiagnosisView, HostKeyDialog, stepLabel, TestStepper } from "../stepper";
import "../form/form.css";
import "../manage.css";

/** Arrow keys (and Home/End) move focus between the starting-point tiles; Enter/Space still choose. */
export const arrowTiles = (e: KeyboardEvent & { currentTarget: HTMLElement }) => {
  const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : e.key === "Home" ? "first" : e.key === "End" ? "last" : 0;
  if (!next) return;
  const btns = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(".mm-tile__btn")];
  const at = btns.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0) return;
  const rtl = getComputedStyle(e.currentTarget).direction === "rtl" && (e.key === "ArrowLeft" || e.key === "ArrowRight");
  const to = next === "first" ? 0 : next === "last" ? btns.length - 1 : Math.min(btns.length - 1, Math.max(0, at + (rtl ? -next : next)));
  e.preventDefault();
  btns[to]?.focus();
};

const ICONS: Record<StartingPoint, LucideIcon> = { atlas: CloudDownload, local: Laptop, network: Server, ssh: KeyRound, string: Braces };
const KINDS: readonly StartingPoint[] = ["atlas", "local", "network", "ssh", "string"];

export interface WizardProps {
  /** Skips step 1 (S2 already picked a tile). */
  kind?: StartingPoint;
  /** The loopback address the probe found. */
  hit?: LocalHit;
  defaultAi: Parameters<typeof createFormController>[0]["defaultAi"];
  happyPreset?: boolean;
  onClose: () => void;
  onSaved?: (p: ProfileView) => void;
  /** "Connect now" after saving. */
  onConnect?: (p: ProfileView) => void;
}

/** S3: pick a starting point, fill the trimmed form, test and save. Nothing is stored before the last step. */
export function Wizard(props: WizardProps) {
  const [kind, setKind] = createSignal<StartingPoint | undefined>(props.kind);
  return (
    <Show
      when={kind()}
      fallback={
        <Dialog open size="lg" onClose={props.onClose} title={t("mongoManage.wizard.title")} description={t("mongoManage.wizard.pick")}
          footer={<Button variant="ghost" onClick={props.onClose}>{t("mongoManage.cancel")}</Button>}
        >
          <div class="mm-wiz__steps" aria-hidden="true"><span data-on>1</span><span>2</span><span>3</span></div>
          <ul class="mm-tiles mm-tiles--pick" aria-label={t("mongoManage.first.tiles")} onKeyDown={arrowTiles}>
            <For each={KINDS}>
              {(k) => (
                <li class="mm-tile mm-tile--pick">
                  <button type="button" class="mm-tile__btn" onClick={() => setKind(k)}>
                    <span class="mm-tile__icon" aria-hidden="true">{(() => { const I = ICONS[k]; return <I size={18} />; })()}</span>
                    <span class="mm-tile__title">{t(`mongoManage.tile.${k}.title`)}</span>
                    <span class="mm-tile__desc">{t(`mongoManage.tile.${k}.desc`)}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Dialog>
      }
    >
      {(k) => <WizardBody {...props} kind={k()} onBack={() => setKind(undefined)} />}
    </Show>
  );
}

const initialOf = (kind: StartingPoint, hit?: LocalHit) => {
  const base = startingSpec(kind);
  const spec: ConnSpec = structuredClone(base.spec);
  if (hit && spec.hosts?.length) spec.hosts[0] = { host: hit.host, port: hit.port };
  return { spec, environment: base.environment, name: kind === "local" ? t("mongoManage.wizard.name.local") : "" };
};

function WizardBody(props: WizardProps & { kind: StartingPoint; onBack: () => void }) {
  const [step, setStep] = createSignal<2 | 3 | 4>(2);
  const [saved, setSaved] = createSignal<ProfileView>();
  const [more, setMore] = createSignal(false);
  const [allowDialog, setAllowDialog] = createSignal<string[]>();
  const first: FormTab = props.kind === "ssh" ? "tunnel" : "connection";
  const f = createFormController({
    defaultAi: props.defaultAi,
    happyPreset: props.happyPreset,
    initial: initialOf(props.kind, props.hit),
    tab: first,
    // The controller closes the form after a save; the wizard keeps its own dialog open for the last step.
    onClose: () => {
      if (!saved()) props.onClose();
    },
    onSaved: (p) => (setSaved(p), setStep(4), props.onSaved?.(p)),
  });
  onMount(() => {
    if (props.kind === "atlas" || props.kind === "string") f.setMode("string");
  });
  const tunnelOn = () => f.spec().tunnel?.kind === "ssh";
  const failed = () => f.steps().find((s) => s.state === "failed");
  const diag = () => (f.report() && !f.report()!.ok ? (f.report()!.diagnosis ?? undefined) : undefined);

  function next() {
    if (f.errors().length) {
      f.setShowErrors(true);
      const e = f.errors()[0];
      setMore(e.tab === "tls" || e.tab === "advanced" || e.tab === "safety" || e.tab === "ai" ? true : more());
      document.getElementById(fieldId(e.path))?.focus();
      return;
    }
    setStep(3);
  }

  return (
    <FormContext.Provider value={f}>
      <Dialog
        open
        size="xl"
        onClose={props.onClose}
        title={step() === 4 ? t("mongoManage.wizard.done.title") : t("mongoManage.wizard.title")}
        description={step() === 4 ? undefined : t(`mongoManage.wizard.step${step() as 2 | 3}`)}
        footer={
          <div class="mm-wiz__footer">
            <Show when={step() !== 4}>
              <Button variant="ghost" onClick={step() === 2 ? props.onBack : () => setStep(2)}>{t("mongoManage.back")}</Button>
              <span class="mm-grow" />
              <Button variant="ghost" onClick={props.onClose}>{t("mongoManage.cancel")}</Button>
              <Show
                when={step() === 2}
                fallback={
                  <>
                    <Button variant="secondary" onClick={() => void f.runTest()} loading={f.testing()} disabled={f.testBlocked() && !f.testing()}>{t("mongoForm.test.button")}</Button>
                    <Button variant="primary" onClick={() => void f.save()} loading={f.saving()} disabled={f.saving()}>{t("mongoManage.wizard.save")}</Button>
                  </>
                }
              >
                <Button variant="primary" onClick={next}>{t("mongoManage.next")}</Button>
              </Show>
            </Show>
            <Show when={step() === 4}>
              <span class="mm-grow" />
              <Button variant="ghost" onClick={props.onClose}>{t("mongoManage.close")}</Button>
              <Button variant="primary" data-autofocus onClick={() => (props.onConnect?.(saved()!), props.onClose())}>{t("mongoManage.wizard.done.connect")}</Button>
            </Show>
          </div>
        }
      >
        <div class="mm-wiz">
          <Show when={step() !== 4}>
            <div class="mm-wiz__steps" aria-hidden="true">
              <span data-on={step() >= 1 ? "" : undefined}>1</span>
              <span data-on={step() >= 2 ? "" : undefined}>2</span>
              <span data-on={step() >= 3 ? "" : undefined}>3</span>
            </div>
          </Show>

          {/* Step 2 stays mounted while step 3 is shown: what was typed must survive Back. */}
          <div hidden={step() !== 2} class="mgf">
            <header class="mgf-head">
              <div class="mgf-head__name">
                <TextField path="name" label={t("mongoForm.name.label")} placeholder={t("mongoForm.name.placeholder")} value={f.s.name} onInput={(v) => f.setS("name", v)} autofocus />
                <StarToggle on={f.s.favorite} onChange={(v) => f.setS("favorite", v)} label={f.s.favorite ? t("mongoForm.favorite.on") : t("mongoForm.favorite.off")} />
              </div>
              <SegmentedControl
                aria-label={t("mongoForm.env.label")}
                size="sm"
                value={f.s.environment}
                onChange={f.setEnvironment}
                options={[
                  { value: "local", label: t("mongoForm.env.local") },
                  { value: "sandbox", label: t("mongoForm.env.sandbox") },
                  { value: "production", label: t("mongoForm.env.production") },
                ]}
              />
              <p class="mm-hint">{f.rule().level === "local" ? t("mongoManage.wizard.tag.local") : t("mongoManage.wizard.tag.remote")}</p>
            </header>
            <Show when={f.showErrors() && f.errors().length}>
              <section class="mgf-summary" role="alert" aria-label={t("mongoForm.summary.title", { count: f.errors().length })}>
                <p><TriangleAlert size={14} aria-hidden="true" /> <strong>{t("mongoForm.summary.title", { count: f.errors().length })}</strong></p>
                <ul>
                  <For each={f.errors()}>{(p) => <li><button type="button" class="mgf-link" onClick={() => document.getElementById(fieldId(p.path))?.focus()}>{problemText(p)}</button></li>}</For>
                </ul>
              </section>
            </Show>
            <div class="mm-wiz__sections">
              <Show when={props.kind === "ssh"}>
                <section class="mm-wiz__sec"><h4>{t("mongoManage.wizard.sec.tunnel")}</h4><TunnelTab /></section>
              </Show>
              <section class="mm-wiz__sec"><h4>{t("mongoManage.wizard.sec.connection")}</h4><ConnectionTab /></section>
              <section class="mm-wiz__sec"><h4>{t("mongoForm.tab.auth")}</h4><AuthTab /></section>
              <Button size="sm" variant="ghost" aria-expanded={more()} aria-controls="mm-wiz-more" onClick={() => setMore(!more())}>{more() ? t("mongoManage.wizard.fewer") : t("mongoManage.wizard.more")}</Button>
              <div id="mm-wiz-more" hidden={!more()} class="mm-wiz__more">
                <Show when={props.kind !== "ssh"}>
                  <section class="mm-wiz__sec"><h4>{t("mongoForm.tab.tunnel")}</h4><TunnelTab /></section>
                </Show>
                <section class="mm-wiz__sec"><h4>{t("mongoForm.tab.tls")}</h4><TlsTab /></section>
                <section class="mm-wiz__sec"><h4>{t("mongoForm.tab.advanced")}</h4><AdvancedTab /></section>
                <section class="mm-wiz__sec"><h4>{t("mongoForm.tab.safety")}</h4><SafetyTab /></section>
              </div>
            </div>
          </div>

          <Show when={step() === 3}>
            <div class="mm-wiz__review">
              <dl class="mm-facts">
                <dt>{t("mongoForm.name.label")}</dt><dd>{f.s.name || t("mongoForm.draftName")}</dd>
                <dt>{t("mongoForm.env.label")}</dt><dd>{t(`mongoForm.env.${f.s.environment}`)}</dd>
                <Show when={f.masked()}><dt>{t("mongoManage.wizard.uri")}</dt><dd class="ui-mono" dir="ltr">{f.masked()}</dd></Show>
              </dl>
              <Show when={f.lowering().length}>
                <section class="mgf-confirm">
                  <label for="mm-wiz-confirm"><strong>{t("mongoForm.confirm.title")}</strong> {t("mongoForm.confirm.body", { name: f.s.name.trim() || "…" })}</label>
                  <ul><For each={f.lowering()}>{(r) => <li>{t(`mongoForm.confirm.reason.${r}`)}</li>}</For></ul>
                  <Input id="mm-wiz-confirm" aria-label={t("mongoForm.confirm.aria")} autocomplete="off" spellcheck={false} value={f.s.confirm} invalid={!!f.s.confirm && !f.isConfirmed()} onInput={(e) => f.setS("confirm", e.currentTarget.value)} />
                </section>
              </Show>
              <Show when={f.saveError()}><p class="mgf-danger" role="alert"><CircleAlert size={14} aria-hidden="true" /> {f.saveError()}</p></Show>
              <Show when={f.testError()}><p class="mgf-danger" role="alert"><CircleAlert size={14} aria-hidden="true" /> {f.testError()}</p></Show>
              <Show when={!f.testing() && !f.report() && !f.testError()}><p class="mm-hint">{t("mongoManage.wizard.testHint")}</p></Show>
              <Show when={f.testing() || f.steps().length || f.report()}>
                <TestStepper tunnel={tunnelOn()} running={f.testing()} cancelled={f.cancelled()} steps={f.steps()} report={f.report()} onCancel={() => void f.cancelTest()} unallowedMembers={f.unallowedMembers()} onAllowMembers={(h) => setAllowDialog(h)}>
                  <Show when={diag()}>
                    {(d) => (
                      <DiagnosisView
                        diagnosis={d()}
                        failedStep={failed() ? stepLabel(failed()!.id) : undefined}
                        onRetry={() => void f.runTest()}
                        onReviewHostKey={() => (f.report()?.hostKey ? f.setHostKey({ view: f.report()!.hostKey!, host: f.report()!.hostKey!.host }) : void f.checkHostKey())}
                        onAllowHost={(h) => setAllowDialog([h])}
                        onEnterSecret={() => (setStep(2), f.goto("auth", secretFieldId("password")))}
                      />
                    )}
                  </Show>
                </TestStepper>
              </Show>
            </div>
          </Show>

          <Show when={step() === 4 && saved()}>{(p) => <Done profile={p()} f={f} />}</Show>
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

/** After saving: what to do next, and the one habit worth forming (a read-only database user). */
function Done(props: { profile: ProfileView; f: FormController }) {
  const db = () => props.f.spec().database || "admin";
  const snippet = () => readOnlyUserCommand(db());
  return (
    <div class="mm-done">
      <p class="mm-done__ok" role="status"><CircleCheck size={16} aria-hidden="true" /> {t("mongoManage.wizard.done.saved", { name: props.profile.name })}</p>
      <section class="mm-tip" aria-labelledby="mm-tip-h">
        <h4 id="mm-tip-h">{t("mongoManage.wizard.tip.title")}</h4>
        <p>{t("mongoManage.wizard.tip.body")}</p>
        <div class="mm-snippet">
          <pre dir="ltr"><code>{snippet()}</code></pre>
          <Button size="sm" variant="ghost" icon={Copy} aria-label={t("mongoManage.wizard.tip.copy")} onClick={() => void navigator.clipboard?.writeText(snippet()).then(() => toast.info(t("mongoManage.first.copied")))} />
        </div>
      </section>
      <p class="mm-hint">{t("mongoManage.wizard.done.ai")}</p>
    </div>
  );
}
