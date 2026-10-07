import { For, Show } from "solid-js";
import { modelLabel } from "../../components/chat/format";
import { t } from "../../i18n";
import type { AutoInfo } from "../../store/agent-types";
import { Badge, Button, Info, ShieldAlert, Skeleton } from "../../ui-kit";
import { excludeReasonText } from "../roles/rolesLogic";
import { autoReasonText, delegateKindText, derivationSummary } from "./newRunLogic";
import { roleColor } from "./roleColors";

export interface UntrustedRole {
  name: string;
  /** Repositories that hold the copy. */
  repos: string[];
}

/**
 * What an Auto run would start with, shown before Start: the lead, the roles it can hand work to, the roles it will not use
 * (and why), a queue reason when the repository is busy, the spend cap and the worst case. It only displays; the dialog owns the data.
 */
export function AutoCard(props: {
  info: AutoInfo | undefined;
  loading: boolean;
  /** Provider of the run when it is not Claude: Auto is then one agent, no delegation. */
  otherProvider?: string;
  untrusted: UntrustedRole[];
  /** Show the one-time "roles take their permission from their file" card. */
  showFirstLaunch: boolean;
  onDismissFirstLaunch: () => void;
  onTrust: (name: string) => void;
  onManage: () => void;
}) {
  const info = () => props.info;
  const excluded = () => (info()?.excluded ?? []).filter((x) => x.reason !== "untrusted");
  return (
    <section class="auto-card" aria-label={t("runs.new.auto")} aria-busy={props.loading}>
      <Show when={!props.loading} fallback={<div class="auto-card__loading" role="status"><Skeleton height={14} width="60%" /><Skeleton height={14} width="85%" /><span class="ui-sr-only">{t("runs.auto.loading")}</span></div>}>
        <Show when={props.otherProvider} fallback={
          <Show when={info()}>
            {(i) => (
              <>
                <p class="auto-card__lead">{t("modes.autoLead", { model: modelLabel(i().model), effort: i().effort ?? t("runs.na") })}</p>
                <Show when={i().delegates.length > 0} fallback={<p class="auto-card__note">{t("runs.new.autoAlone")}</p>}>
                  <div class="auto-card__delegates">
                    <span class="auto-card__label">{t("runs.new.autoDelegates")}</span>
                    <ul class="auto-card__chips">
                      <For each={i().delegates}>
                        {(d) => (
                          <li class="auto-card__chip" title={[d.description, delegateKindText(d)].filter(Boolean).join(" · ")}>
                            <span class="run-card__swatch" style={{ background: d.color ?? roleColor(d.name) ?? "var(--text-4)" }} aria-hidden="true" />
                            <span class="auto-card__chip-name">{d.name}</span>
                            <Badge size="sm">{modelLabel(d.model)}</Badge>
                          </li>
                        )}
                      </For>
                    </ul>
                  </div>
                </Show>
                <Show when={excluded().length > 0}>
                  <p class="auto-card__note">
                    <span title={excluded().map((x) => `${x.name}: ${excludeReasonText(x.reason)}`).join("\n")}>{t("runs.new.autoExcluded", { count: excluded().length })}</span>
                    {" "}
                    <Button size="sm" variant="ghost" class="auto-card__link" onClick={props.onManage}>{t("runs.new.manageRoles")}</Button>
                  </p>
                </Show>
                <Show when={i().queuedBehind}>
                  {(q) => (
                    <p class="auto-card__queue" role="status">
                      {q().kind === "writers" ? t("runs.auto.queueWriters") : q().kind === "slots" ? t("runs.auto.queueSlots") : t("runs.auto.queueReason", { run: q().title || q().agentId })}
                    </p>
                  )}
                </Show>
                <p class="auto-card__facts">
                  <span>{i().maxBudgetUsd ? t("runs.auto.budget", { usd: i().maxBudgetUsd! }) : t("runs.auto.budgetNone")}</span>
                  <span>{t("runs.auto.worstCase", { turns: i().worstCaseTurns })}</span>
                </p>
                <Show when={i().delegationOff}>
                  {(code) => <p class="auto-card__note" data-tone="warn">{t("runs.auto.limited", { reason: autoReasonText(code()) })}</p>}
                </Show>
              </>
            )}
          </Show>
        }>
          {(provider) => <p class="auto-card__lead">{t("runs.auto.otherProvider", { provider: provider() })}</p>}
        </Show>
        <Show when={props.untrusted.length > 0}>
          <ul class="auto-card__untrusted" aria-label={t("runs.auto.untrustedAria")}>
            <For each={props.untrusted}>
              {(u) => (
                <li>
                  <ShieldAlert size={14} />
                  <span>{t("runs.auto.untrusted", { name: u.name, repos: u.repos.join(", ") })}</span>
                  <Button size="sm" variant="secondary" onClick={() => props.onTrust(u.name)}>{t("roles.trust.trustButton")}</Button>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={props.showFirstLaunch && (info()?.delegates.length ?? 0) > 0}>
          <div class="auto-card__first" role="status">
            <Info size={14} />
            <span>{t("runs.auto.firstLaunch", { summary: derivationSummary(info()!.delegates) })}</span>
            <Button size="sm" variant="secondary" onClick={props.onDismissFirstLaunch}>{t("roles.derivedNotice.ok")}</Button>
          </div>
        </Show>
      </Show>
    </section>
  );
}
