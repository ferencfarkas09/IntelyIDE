import { createResource, For, Show } from "solid-js";
import { t, type MessageKey } from "../../i18n";
import { repoName } from "../../store/actions";
import { Badge, Button, CircleAlert, CircleCheck, Copy, FormGroup, FormRow, Info, RefreshCw, Skeleton, toast, TriangleAlert, Wrench, type Tone } from "../../ui-kit";
import type { DoctorFinding } from "../../ipc/providers";
import { doctorApi } from "./doctorApi";
import { counts, groupChecks, itemText, levelTone, messageOf, summaryText } from "./doctorLogic";
import type { DoctorLevelName } from "./doctorTypes";
import "./doctor.css";

const ICON = { ok: CircleCheck, info: Info, warn: TriangleAlert, error: CircleAlert } as const;

/** The expanded Doctor (tools, credentials, PATH, disk, locks, hooks, untracked, leftovers). Reports only; one safe fix. */
export default function DoctorChecks(props: { extra?: readonly DoctorFinding[] }) {
  const [report, { refetch }] = createResource(() => doctorApi().run().catch(() => undefined));
  const checks = () => report()?.checks ?? [];
  const tone = (l: DoctorLevelName): Tone => levelTone(l);

  async function copy() {
    const extra = (props.extra ?? []).map((f) => ({ level: f.level, text: `${f.provider ? `${f.provider}: ` : ""}${f.message}` }));
    const text = summaryText(checks(), repoName, extra);
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("doctor.copied"));
    } catch {
      toast.error(t("doctor.copyFailed"));
    }
  }
  async function fix() {
    try {
      await doctorApi().refreshEnv();
      toast.success(t("doctor.refreshed"));
    } catch {
      toast.error(t("doctor.refreshFailed"));
    }
    void refetch();
  }
  const summary = () => {
    const c = counts(checks());
    return t("doctor.summary", { warn: c.warn, error: c.error, ok: c.ok });
  };

  return (
    <FormGroup title={t("doctor.title")} description={t("doctor.desc")}>
      <FormRow label={t("doctor.report")} stacked>
        <div class="doc">
          <Show when={!report.loading || report()} fallback={<Skeleton height={120} />}>
            <Show when={report()} fallback={<p class="sc-muted">{t("doctor.unavailable")}</p>}>
              <p class="doc__summary" role="status">{summary()}</p>
              <For each={groupChecks(checks())}>
                {(g) => (
                  <section class="doc__group" aria-label={t(`doctor.group.${g.group}` as MessageKey)}>
                    <h4 class="doc__heading">{t(`doctor.group.${g.group}` as MessageKey)}</h4>
                    <ul class="doc__list">
                      <For each={g.checks}>
                        {(c) => (
                          <li class="doc__row" data-code={c.code} data-level={c.level}>
                            <Badge size="sm" tone={tone(c.level)} icon={ICON[c.level]}>{t(`aboutSection.level.${c.level}` as MessageKey)}</Badge>
                            <div class="doc__text">
                              <span>{messageOf(c, repoName)}</span>
                              <Show when={c.items.length}>
                                <ul class="doc__items">
                                  <For each={c.items.slice(0, 8)}>{(i) => <li class="ui-mono" title={i.name}>{itemText(i)}</li>}</For>
                                  <Show when={c.items.length > 8}><li class="doc__more">{t("doctor.more", { n: c.items.length - 8 })}</li></Show>
                                </ul>
                              </Show>
                            </div>
                            <Show when={c.fix === "refreshEnv"}>
                              <Button size="sm" variant="secondary" icon={Wrench} onClick={() => void fix()}>{t("doctor.fix.refreshEnv")}</Button>
                            </Show>
                          </li>
                        )}
                      </For>
                    </ul>
                  </section>
                )}
              </For>
            </Show>
          </Show>
          <div class="doc__actions">
            <Button size="sm" icon={RefreshCw} loading={report.loading} onClick={() => void refetch()}>{t("aboutSection.runAgain")}</Button>
            <Button size="sm" icon={Copy} disabled={!report()} onClick={() => void copy()}>{t("doctor.copy")}</Button>
          </div>
        </div>
      </FormRow>
    </FormGroup>
  );
}
