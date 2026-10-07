import { createMemo, For, Show, type JSX } from "solid-js";
import { t, type MessageKey } from "../../../i18n";
import type { StepState, TestReport, TestStep } from "../../../ipc/mongo";
import { Button, CircleAlert, CircleCheck, Minus, ShieldCheck, Spinner, TriangleAlert } from "../../../ui-kit";
import "./stepper.css";
import { formatMs, overall, stateLabel, stepLabel, visibleSteps, warningKey, type StepRow } from "./logic";

export interface TestStepperProps {
  /** Steps as reported so far (`mongo:test` events) or in the final report. */
  steps?: readonly TestStep[];
  /** A tunnel is configured: the Tunnel step is listed. */
  tunnel: boolean;
  running: boolean;
  cancelled?: boolean;
  /** The final report; drives the success summary. */
  report?: TestReport;
  onCancel?: () => void;
  /** Members the server announced that the tunnel does not allow yet; the button opens the "Allow these N hosts" dialog. */
  unallowedMembers?: readonly string[];
  onAllowMembers?: (hosts: string[]) => void;
  /** Rendered under the list, normally the DiagnosisView of a failure. */
  children?: JSX.Element;
}

function StateIcon(props: { state: StepState }) {
  return (
    <span class="mgs-step__icon" aria-hidden="true">
      {props.state === "running" ? <Spinner size={14} /> : props.state === "ok" ? <CircleCheck size={14} /> : props.state === "warn" ? <TriangleAlert size={14} /> : props.state === "failed" ? <CircleAlert size={14} /> : props.state === "skipped" ? <Minus size={14} /> : <span class="mgs-step__dot" />}
    </span>
  );
}

/** The connection test as a list of steps. Every state has an icon AND a word, never colour alone; the status line is a polite live region. */
export function TestStepper(props: TestStepperProps) {
  const rows = createMemo<StepRow[]>(() => visibleSteps(props.steps, { tunnel: props.tunnel }));
  const state = createMemo(() => overall(rows(), { running: props.running, cancelled: props.cancelled, ok: props.report?.ok }));
  const current = () => rows().find((r) => r.state === "running") ?? rows().find((r) => r.state === "pending");
  const failedRow = () => rows().find((r) => r.state === "failed");
  const status = () => {
    switch (state()) {
      case "running": return t("mongoDiag.stepper.status.running", { step: current() ? stepLabel(current()!.id) : "…" });
      case "ok": return t("mongoDiag.stepper.status.ok", { time: formatMs(props.report?.elapsedMs ?? 0) });
      case "warn": return t("mongoDiag.stepper.status.warn");
      case "failed": return t("mongoDiag.stepper.status.failed", { step: failedRow() ? stepLabel(failedRow()!.id) : "" });
      case "cancelled": return t("mongoDiag.stepper.status.cancelled");
      default: return t("mongoDiag.stepper.status.idle");
    }
  };
  const conn = () => props.report?.ok ? props.report.connection ?? undefined : undefined;
  const topology = () => {
    const k = conn()?.topology;
    return t((k === "standalone" || k === "replicaSet" || k === "sharded" ? `mongoDiag.result.topology.${k}` : "mongoDiag.result.topology.unknown") as MessageKey);
  };
  const role = () => {
    const r = conn()?.role.role;
    return t((r === "readOnly" ? "mongoDiag.result.role.readOnly" : r === "canWrite" ? "mongoDiag.result.role.canWrite" : "mongoDiag.result.role.unknown") as MessageKey);
  };

  return (
    <section class="mgs" data-state={state()} aria-label={t("mongoDiag.stepper.label")}>
      <ol class="mgs__list" role="list">
        <For each={rows()}>
          {(r) => (
            <li class="mgs-step" data-state={r.state} data-step={r.id} aria-current={r.state === "running" ? "step" : undefined}>
              <StateIcon state={r.state} />
              <span class="mgs-step__name">{stepLabel(r.id)}</span>
              <span class="mgs-step__state">{stateLabel(r.state)}</span>
              <span class="mgs-step__ms">{r.state === "ok" || r.state === "warn" || r.state === "failed" ? (r.ms > 0 ? formatMs(r.ms) : "") : ""}</span>
            </li>
          )}
        </For>
      </ol>
      <div class="mgs__foot">
        <p class="mgs__status" role="status" aria-live="polite">{status()}</p>
        <Show when={props.running && props.onCancel}>
          <Button size="sm" variant="ghost" onClick={() => props.onCancel?.()}>{t("mongoDiag.stepper.cancel")}</Button>
        </Show>
      </div>
      <Show when={conn()}>
        {(c) => (
          <div class="mgs-ok">
            <div class="mgs-ok__head"><ShieldCheck size={16} aria-hidden="true" /><strong>{t("mongoDiag.result.title")}</strong></div>
            <ul class="mgs-ok__facts" role="list">
              <li>{t("mongoDiag.result.version", { version: c().serverVersion })}</li>
              <li>{topology()}</li>
              <li>{t("mongoDiag.result.ping", { ms: c().pingMs })}</li>
              <li>{c().tls ? t("mongoDiag.result.tlsOn") : t("mongoDiag.result.tlsOff")}</li>
              <li data-elevated={c().roleElevated ? "" : undefined}>{role()}</li>
            </ul>
          </div>
        )}
      </Show>
      <Show when={(props.report?.warnings?.length ?? 0) > 0 && props.report?.ok}>
        <div class="mgs-warn" role="status">
          <h4 class="mgs-warn__title"><TriangleAlert size={14} aria-hidden="true" />{t("mongoDiag.result.warnings")}</h4>
          <ul role="list">
            <For each={props.report?.warnings ?? []}>{(w) => <li>{(() => { const k = warningKey(w); return t(k.key, k.params); })()}</li>}</For>
          </ul>
        </div>
      </Show>
      <Show when={props.onAllowMembers && (props.unallowedMembers?.length ?? 0) > 0}>
        <div class="mgs-members">
          <p>{t("mongoDiag.members.text", { count: props.unallowedMembers!.length })}</p>
          <Button size="sm" variant="secondary" onClick={() => props.onAllowMembers?.([...props.unallowedMembers!])}>{t("mongoDiag.members.allow", { count: props.unallowedMembers!.length })}</Button>
        </div>
      </Show>
      {props.children}
    </section>
  );
}
