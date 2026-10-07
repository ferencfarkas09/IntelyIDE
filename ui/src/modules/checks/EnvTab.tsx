import { createSignal, For, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { repoName } from "../../store/actions";
import { Badge, Button, EmptyState, Icon, KeyRound, Lock, RefreshCw, Skeleton, TriangleAlert } from "../../ui-kit";
import { checksApi } from "./api";
import { errorText } from "./logic";
import type { EnvReport, Presence } from "./types";
import "./checks.css";

/** `declared` and used, declared only, used only (missing from the example), or neither. */
function cell(p: Presence): { sym: string; tone: string; label: string } {
  if (p.declared && p.referenced) return { sym: "●", tone: "ok", label: t("checks.env.cell.both") };
  if (p.declared) return { sym: "○", tone: "muted", label: t("checks.env.cell.declared") };
  if (p.referenced) return { sym: "▲", tone: "warn", label: t("checks.env.cell.used") };
  return { sym: "–", tone: "none", label: t("checks.env.cell.none") };
}

/** Environment variable NAMES across the repos: what the example files declare and what the code references. */
export default function EnvTab() {
  const [report, setReport] = createSignal<EnvReport | undefined>(undefined);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [loading, setLoading] = createSignal(false);
  async function load() {
    setLoading(true);
    try {
      setReport(await checksApi().env());
      setError(undefined);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }
  onMount(() => void load());
  const repoIds = () => report()?.repos.map((r) => r.repoId) ?? [];
  return (
    <div class="env">
      <div class="env__bar">
        <Icon icon={KeyRound} size={16} />
        <h2 class="env__title">{t("checks.env.title")}</h2>
        <span class="env__spacer" />
        <Button size="sm" variant="secondary" icon={RefreshCw} loading={loading()} onClick={() => void load()}>
          {t("checks.env.refresh")}
        </Button>
      </div>
      <p class="env__privacy">
        <Icon icon={Lock} size={12} /> {t("checks.env.privacy")}
      </p>
      <Show when={error()}><p class="chk__error" role="alert">{error()}</p></Show>
      <Show when={report()} fallback={<Show when={loading()}><div class="env__loading"><Skeleton height={64} /><Skeleton height={64} /></div></Show>}>
        {(r) => (
          <>
            <div class="env__repos">
              <For each={r().repos}>
                {(repo) => (
                  <section class="env__card" aria-label={t("checks.env.repoVars", { name: repoName(repo.repoId) })}>
                    <header class="env__cardhead">
                      <h3 class="env__repo">{repoName(repo.repoId)}</h3>
                      <Badge size="sm" tone="neutral">{t("checks.env.declaredN", { n: repo.declared })}</Badge>
                      <Badge size="sm" tone="neutral">{t("checks.env.usedN", { n: repo.referenced })}</Badge>
                      <Show when={repo.missing.length}><Badge size="sm" tone="warn" icon={TriangleAlert}>{t("checks.env.missingN", { n: repo.missing.length })}</Badge></Show>
                    </header>
                    <div class="env__files">
                      <For each={repo.files}>
                        {(f) => (
                          <span class="env__file" data-kind={f.kind} title={f.kind === "real" ? t("checks.env.realTitle") : t("checks.env.namesN", { n: f.names.length })}>
                            <Show when={f.kind === "real"}><Icon icon={Lock} size={12} /></Show>
                            <span class="ui-mono">{f.path}</span>
                            <Show when={f.kind === "example"}><span class="ui-tnum env__count">{f.names.length}</span></Show>
                          </span>
                        )}
                      </For>
                      <Show when={!repo.hasExample}><span class="env__none">{t("checks.env.noExample")}</span></Show>
                    </div>
                    <Show when={repo.missing.length}>
                      <ul class="env__missing" aria-label={t("checks.env.undeclared")}>
                        <For each={repo.missing}>
                          {(m) => (
                            <li><span class="ui-mono env__name">{m.name}</span><span class="env__where ui-truncate" title={m.usedIn.join(", ")}>{m.usedIn.join(", ")}</span></li>
                          )}
                        </For>
                      </ul>
                    </Show>
                    <Show when={repo.missingTotal > repo.missing.length}><p class="chk__hint">{t("checks.env.showing", { shown: repo.missing.length, total: repo.missingTotal })}</p></Show>
                    <Show when={repo.truncated}><p class="chk__hint">{t("checks.env.limit")}</p></Show>
                  </section>
                )}
              </For>
            </div>
            <Show when={r().names.length} fallback={<EmptyState size="sm" icon={KeyRound} title={t("checks.env.emptyTitle")} description={t("checks.env.emptyDesc")} />}>
              <div class="env__matrix-wrap">
                <table class="env__matrix">
                  <thead>
                    <tr>
                      <th scope="col">{t("checks.env.name")}</th>
                      <For each={repoIds()}>{(id) => <th scope="col">{repoName(id)}</th>}</For>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={r().names}>
                      {(row) => (
                        <tr>
                          <th scope="row" class="ui-mono">{row.name}</th>
                          <For each={row.repos}>
                            {(p) => {
                              const c = cell(p);
                              return <td data-tone={c.tone} title={c.label} aria-label={c.label}>{c.sym}</td>;
                            }}
                          </For>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
              <p class="chk__hint">{t("checks.env.legend")}</p>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
