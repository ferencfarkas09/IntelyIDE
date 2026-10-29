import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { t } from "../../i18n";
import { requestNewRun } from "../../platform/newRun";
import { errorText } from "../../store/snapshots";
import { repoConfig, repos } from "../../store/workspace";
import { Badge, Button, CircleAlert, CircleCheck, EmptyState, Icon, IconButton, Info, RefreshCw, RepoBadge, Skeleton, Smartphone, Sparkles, toast, TriangleAlert } from "../../ui-kit";
import { mobileHealthApi, refreshDetected } from "./api";
import { agentPrompt, checklistText, checklistTitle, counts, factLabel, factValue, findingTitle, findingWhy, groupFindings, locationOf, skippedText } from "./logic";
import type { ChecklistItem, Finding, Project, RepoHealth, Severity, Status } from "./types";
import "./mobilehealth.css";

const SEV_TONE = { error: "danger", warn: "warn", info: "info" } as const satisfies Record<Severity, string>;
const SEV_KEY = { error: "mobilehealth.sev.error", warn: "mobilehealth.sev.warn", info: "mobilehealth.sev.info" } as const satisfies Record<Severity, string>;
const SEV_ICON = { error: CircleAlert, warn: TriangleAlert, info: Info } as const satisfies Record<Severity, unknown>;
const STATUS_KEY = { ok: "mobilehealth.status.ok", missing: "mobilehealth.status.missing", check: "mobilehealth.status.check" } as const satisfies Record<Status, string>;
const STATUS_TONE = { ok: "ok", missing: "danger", check: "warn" } as const satisfies Record<Status, string>;
const CONFIDENCE_KEY = { high: "mobilehealth.confidence.high", medium: "mobilehealth.confidence.medium", low: "mobilehealth.confidence.low" } as const;

/** The Mobile health tab: for every repository with an iOS or Android project, what is wrong, in plain words, and a button that hands it to an agent. */
export default function MobileHealthTab() {
  const [data, setData] = createSignal<RepoHealth[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>(undefined);

  const nameOf = (repoId: string): string => repoConfig(repoId)?.name ?? repoId;

  async function load() {
    setLoading(true);
    try {
      setData(await mobileHealthApi().scan());
      setError(undefined);
      void refreshDetected();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }
  createEffect(on(() => repos().map((r) => r.id).join(","), () => void load()));

  async function ask(repoId: string, project: Project, prompt: string) {
    const opened = await requestNewRun({ prompt: agentPrompt(prompt, project), repoIds: [repoId] });
    if (!opened) toast.error(t("mobilehealth.askFailed"));
  }

  return (
    <div class="mh" data-testid="mobilehealth-tab">
      <header class="mh__bar">
        <Icon icon={Smartphone} size={16} />
        <h2 class="mh__title">{t("mobilehealth.name")}</h2>
        <span class="mh__spacer" />
        <IconButton icon={RefreshCw} label={t("mobilehealth.refresh")} size="sm" loading={loading()} onClick={() => void load()} />
      </header>
      <p class="mh__hint">{t("mobilehealth.readOnly")}</p>

      <Show when={error()}>
        <p class="mh__error" role="alert">
          {error()}
        </p>
      </Show>

      <Show
        when={loaded()}
        fallback={
          <div class="mh__loading">
            <Skeleton height={22} />
            <Skeleton height={22} />
            <Skeleton height={22} />
          </div>
        }
      >
        <Show when={data().length} fallback={<Show when={!error()}><EmptyState icon={Smartphone} size="sm" title={t("mobilehealth.noRepo")} description={t("mobilehealth.noRepoDesc")} /></Show>}>
          <For each={data()}>
            {(repo) => (
              <section class="mh__repo" aria-label={nameOf(repo.repoId)} data-testid={`mobilehealth-repo-${repo.repoId}`}>
                <header class="mh__rhead">
                  <Show when={repoConfig(repo.repoId)}>{(c) => <RepoBadge color={c().color} badge={c().badge} size={20} />}</Show>
                  <h3 class="mh__name">{nameOf(repo.repoId)}</h3>
                  <Show when={counts(repo.projects)}>
                    {(c) => (
                      <span class="mh__counts" role="group" aria-label={t("mobilehealth.summary", { errors: c().error, warnings: c().warn, notes: c().info })}>
                        <Show when={c().error > 0}><Badge size="sm" tone="danger">{c().error}</Badge></Show>
                        <Show when={c().warn > 0}><Badge size="sm" tone="warn">{c().warn}</Badge></Show>
                        <Show when={c().info > 0}><Badge size="sm" tone="info">{c().info}</Badge></Show>
                      </span>
                    )}
                  </Show>
                </header>

                <For each={repo.projects}>
                  {(project) => <ProjectView repoId={repo.repoId} project={project} multiple={repo.projects.length > 1} ask={ask} />}
                </For>

                <For each={repo.skipped}>
                  {(s) => <p class="mh__note"><Icon icon={TriangleAlert} size={12} /> {skippedText(s)}</p>}
                </For>
                <p class="mh__hint">{t("mobilehealth.checklistNote", { compat: repo.data.compat, store: repo.data.store })}</p>
              </section>
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
}

function ProjectView(props: { repoId: string; project: Project; multiple: boolean; ask: (repoId: string, project: Project, prompt: string) => void }) {
  const groups = createMemo(() => groupFindings(props.project.findings));
  return (
    <div class="mh__project">
      <Show when={props.multiple || props.project.path}>
        <p class="mh__hint">{t("mobilehealth.project", { path: props.project.path || t("mobilehealth.rootProject") })}</p>
      </Show>

      <Show when={props.project.facts.length}>
        <dl class="mh__facts" aria-label={t("mobilehealth.facts")}>
          <For each={props.project.facts}>
            {(f) => (
              <div class="mh__fact" title={locationOf(f)}>
                <dt>{factLabel(f.key)}</dt>
                <dd><code>{factValue(f.value)}</code></dd>
              </div>
            )}
          </For>
        </dl>
      </Show>

      <Show when={groups().length} fallback={<p class="mh__good"><Icon icon={CircleCheck} size={14} /> {t("mobilehealth.allGood")}</p>}>
        <For each={groups()}>
          {(g) => (
            <div class="mh__group">
              <h4 class="mh__h">{t(`mobilehealth.platform.${g.id}`)}</h4>
              <ul class="mh__list">
                <For each={g.items}>{(f) => <FindingRow finding={f} onAsk={() => props.ask(props.repoId, props.project, f.prompt)} />}</For>
              </ul>
            </div>
          )}
        </For>
      </Show>

      <Show when={props.project.checklist.length}>
        <div class="mh__group">
          <h4 class="mh__h">{t("mobilehealth.checklist")}</h4>
          <ul class="mh__list">
            <For each={props.project.checklist}>{(c) => <ChecklistRow item={c} platformLabel={t(`mobilehealth.platform.${c.platform}`)} onAsk={c.prompt ? () => props.ask(props.repoId, props.project, c.prompt!) : undefined} />}</For>
          </ul>
        </div>
      </Show>
    </div>
  );
}

function FindingRow(props: { finding: Finding; onAsk: () => void }) {
  const f = () => props.finding;
  return (
    <li class="mh__item" data-severity={f().severity} data-testid={`finding-${f().id}`}>
      <div class="mh__ihead">
        <Icon icon={SEV_ICON[f().severity]} size={14} class={`mh__sev mh__sev--${f().severity}`} />
        <span class="mh__ititle">{findingTitle(f())}</span>
        <Badge size="sm" tone={SEV_TONE[f().severity]}>{t(SEV_KEY[f().severity])}</Badge>
        <Show when={f().confidence}>{(c) => <Badge size="sm" title={t("mobilehealth.confidenceTip")}>{t(CONFIDENCE_KEY[c()])}</Badge>}</Show>
      </div>
      <p class="mh__why">{findingWhy(f())}</p>
      <div class="mh__ifoot">
        <Show when={locationOf(f())}>{(loc) => <code class="mh__loc">{loc()}</code>}</Show>
        <span class="mh__spacer" />
        <Button size="sm" variant="secondary" aria-label={t("mobilehealth.askFixAria", { title: findingTitle(f()) })} onClick={props.onAsk}>
          <Icon icon={Sparkles} size={12} /> {t("mobilehealth.askFix")}
        </Button>
      </div>
    </li>
  );
}

function ChecklistRow(props: { item: ChecklistItem; platformLabel: string; onAsk?: () => void }) {
  const c = () => props.item;
  return (
    <li class="mh__item mh__item--check" data-status={c().status} data-testid={`check-${c().id}`}>
      <div class="mh__ihead">
        <span class="mh__ititle">{checklistTitle(c())}</span>
        <Badge size="sm">{props.platformLabel}</Badge>
        <Badge size="sm" tone={STATUS_TONE[c().status]}>{t(STATUS_KEY[c().status])}</Badge>
      </div>
      <p class="mh__why">{checklistText(c())}</p>
      <Show when={props.onAsk || locationOf({ file: c().file, line: null })}>
        <div class="mh__ifoot">
          <Show when={c().file}>{(file) => <code class="mh__loc">{file()}</code>}</Show>
          <span class="mh__spacer" />
          <Show when={props.onAsk}>
            <Button size="sm" variant="secondary" aria-label={t("mobilehealth.askFixAria", { title: checklistTitle(c()) })} onClick={() => props.onAsk?.()}>
              <Icon icon={Sparkles} size={12} /> {t("mobilehealth.askFix")}
            </Button>
          </Show>
        </div>
      </Show>
    </li>
  );
}
