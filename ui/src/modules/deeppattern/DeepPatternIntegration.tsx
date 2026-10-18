import { createSignal, For, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { openSettings } from "../../platform/settings";
import { requestNewRun } from "../../platform/newRun";
import { Badge, Button, CircleCheck, Copy, ExternalLink, FormGroup, ShieldCheck, Sparkles, SquareTerminal, StatusDot, toast } from "../../ui-kit";
import { openMcpImport } from "../mcp/importRequest";
import { deepPatternApi, PROJECT_URL } from "./api";
import { AUDIT_PROMPT, mcpPresence, statusLine, stepStates, VERDICT_CHIP } from "./logic";
import { mcpServer, refreshMcp, refreshStatus, status } from "./store";
import type { DpReport } from "./types";
import "../integrations/integrations.css";
import "./deeppattern.css";

const message = (e: unknown): string => (typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e));

/** Opens a terminal and types the command into it. The shell is the person's own; the engine's installer asks for what it needs in its own window. */
async function runInTerminal(command: string): Promise<void> {
  const { openTerminal } = await import("../terminal/store");
  const id = await openTerminal({});
  if (!id) return;
  await ipc.term.write(id, `${command}\n`).catch((e) => toast.error(t("dp.terminalFail"), message(e)));
}

function copy(command: string): void {
  const done = navigator.clipboard?.writeText(command);
  if (!done) return void toast.error(t("dp.copyFail"));
  void done.then(
    () => toast.show({ title: t("dp.copied"), tone: "ok", duration: 2000 }),
    () => toast.error(t("dp.copyFail")),
  );
}

/** A command the person can read, copy and run in the integrated terminal. */
function CommandBox(props: { command: string }) {
  return (
    <div class="dp-cmd">
      <code class="dp-cmd__text">{props.command}</code>
      <div class="int__buttons">
        <Button size="sm" variant="secondary" icon={SquareTerminal} onClick={() => void runInTerminal(props.command)}>{t("dp.action.terminal")}</Button>
        <Button size="sm" variant="ghost" icon={Copy} onClick={() => copy(props.command)}>{t("dp.action.copy")}</Button>
      </div>
    </div>
  );
}

function StepMark(props: { done: boolean }) {
  return (
    <Show when={props.done} fallback={<Badge variant="outline" size="sm">{t("dp.step.todo")}</Badge>}>
      <Badge tone="ok" size="sm" icon={CircleCheck}>{t("dp.step.done")}</Badge>
    </Show>
  );
}

/** Settings > Integrations > DeepPattern: install, activate, check, add to the agents, ask for a second opinion. */
export default function DeepPatternIntegration() {
  const [checking, setChecking] = createSignal(false);
  const [report, setReport] = createSignal<DpReport>();
  const [problem, setProblem] = createSignal<string>();

  onMount(() => {
    void refreshStatus();
    void refreshMcp();
  });

  const steps = () => stepStates(status());
  const line = () => statusLine(status());
  const presence = () => mcpPresence(mcpServer());

  async function check() {
    setChecking(true);
    setProblem(undefined);
    try {
      setReport(await deepPatternApi().doctor());
      await refreshStatus();
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      setReport(undefined);
      setProblem(code === "notInstalled" ? t("dp.err.notInstalled") : code === "readOnly" ? t("dp.err.readOnly") : t("dp.err.check", { message: message(e) }));
    } finally {
      setChecking(false);
    }
  }

  async function audit() {
    if (!(await requestNewRun({ prompt: AUDIT_PROMPT }))) toast.error(t("dp.err.noDialog"));
  }

  return (
    <div class="int dp">
      <p class="intc-lead">{t("dp.lead")}</p>
      <p class="int__line" data-tone={line().tone}>
        <StatusDot tone={line().tone} />
        {line().text}
      </p>

      <FormGroup title={t("dp.step.install.title")} description={t("dp.step.install.text")}>
        <div class="int__details">
          <StepMark done={steps().install === "done"} />
          <Show when={status()}>{(s) => <CommandBox command={s().commands.install} />}</Show>
          <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => void deepPatternApi().openExternal(PROJECT_URL)}>{t("dp.action.project")}</Button>
        </div>
      </FormGroup>

      <FormGroup title={t("dp.step.activate.title")} description={t("dp.step.activate.text")}>
        <div class="int__details">
          <StepMark done={steps().activate === "done"} />
          <Show when={status()}>{(s) => <CommandBox command={s().commands.activate} />}</Show>
          <p class="int__note">{t("dp.step.activate.note")}</p>
        </div>
      </FormGroup>

      <FormGroup title={t("dp.step.check.title")} description={t("dp.step.check.text")}>
        <div class="int__details">
          <Button size="sm" variant="secondary" icon={ShieldCheck} loading={checking()} disabled={status() ? !status()!.doctor : false} onClick={() => void check()}>
            {checking() ? t("dp.action.checking") : t("dp.action.check")}
          </Button>
          <Show when={report()}>
            {(r) => (
              <div class="int__result dp-report" data-ok={r().verdict === "pass" || r().verdict === "warn" ? "" : undefined}>
                <Badge tone={VERDICT_CHIP[r().verdict].tone} size="sm">{VERDICT_CHIP[r().verdict].label()}</Badge>
                <ul class="dp-lines" aria-label={t("dp.step.check.title")}>
                  <For each={r().lines}>{(l) => <li class="dp-line" data-tone={l.tone}>{l.text}</li>}</For>
                </ul>
              </div>
            )}
          </Show>
          <Show when={problem()}><p class="int__fail" role="alert">{problem()}</p></Show>
          <Show when={status()?.root}><p class="int__note">{t("dp.step.check.where", { path: status()!.root })}</p></Show>
        </div>
      </FormGroup>

      <FormGroup title={t("dp.step.agents.title")} description={t("dp.step.agents.text")}>
        <div class="int__details">
          <p class="int__line" data-tone={presence() === "on" ? "ok" : undefined}>
            <StatusDot tone={presence() === "on" ? "ok" : presence() === "missing" ? "neutral" : "warn"} />
            {t(`dp.mcp.${presence()}`)}
          </p>
          <div class="int__buttons">
            <Button size="sm" variant={presence() === "missing" ? "primary" : "secondary"} onClick={openMcpImport}>{t("dp.action.import")}</Button>
            <Show when={presence() !== "missing"}>
              <Button size="sm" variant="ghost" onClick={() => openSettings("mcp")}>{t("dp.action.openMcp")}</Button>
            </Show>
          </div>
        </div>
      </FormGroup>

      <FormGroup title={t("dp.step.audit.title")} description={t("dp.step.audit.text")}>
        <div class="int__details">
          <Button size="sm" variant="primary" icon={Sparkles} onClick={() => void audit()}>{t("dp.action.audit")}</Button>
          <Show when={presence() !== "on"}><p class="int__note">{t("dp.audit.needsMcp")}</p></Show>
        </div>
      </FormGroup>
    </div>
  );
}

