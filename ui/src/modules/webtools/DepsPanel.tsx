import { createSignal, For, Show } from "solid-js";
import { t } from "../../i18n";
import { errorText } from "../../store/snapshots";
import { Badge, Button, CircleCheck, Dialog, Download, EmptyState, Icon, Select } from "../../ui-kit";
import { webtoolsApi } from "./api";
import { depsPrompt } from "./logic";
import { AskButton } from "./shared";
import type { DepsReport, PackageDir } from "./types";

/** Opt-in: nothing runs until the person has read what it does and confirmed. */
export default function DepsPanel(props: { repoId: string; packages: PackageDir[] }) {
  const npm = () => props.packages.filter((p) => p.manager === "npm");
  const others = () => props.packages.filter((p) => p.manager !== "npm");
  const [dir, setDir] = createSignal<string>();
  const [confirming, setConfirming] = createSignal(false);
  const [running, setRunning] = createSignal(false);
  const [report, setReport] = createSignal<DepsReport>();
  const [error, setError] = createSignal<string>();
  const target = () => dir() ?? npm()[0]?.dir ?? "";

  async function run() {
    setConfirming(false);
    setRunning(true);
    setError(undefined);
    try {
      setReport(await webtoolsApi().depsCheck(props.repoId, target(), true));
    } catch (e) {
      setReport(undefined);
      setError(errorText(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div class="wt__panel" data-testid="wt-deps">
      <header class="wt__phead">
        <h3 class="wt__h">{t("webtools.deps.title")}</h3>
        <Badge size="sm" tone="warn">{t("webtools.deps.network")}</Badge>
      </header>
      <p class="wt__hint">{t("webtools.deps.intro")}</p>
      <Show when={npm().length > 0} fallback={<EmptyState icon={Download} size="sm" title={t("webtools.deps.noNpm")} description={others().length ? t("webtools.deps.otherManager", { manager: others()[0]!.manager }) : t("webtools.deps.noNpmDesc")} />}>
        <div class="wt__phead">
          <Show when={npm().length > 1}>
            <Select size="sm" aria-label={t("webtools.deps.folder")} options={npm().map((p) => ({ value: p.dir || ".", label: p.dir || t("webtools.env.root") }))} value={target() || "."} onChange={(v) => setDir(v === "." ? "" : v)} />
          </Show>
          <Button size="sm" variant="primary" icon={Download} loading={running()} onClick={() => setConfirming(true)}>
            {t("webtools.deps.check")}
          </Button>
        </div>
      </Show>
      <Show when={error()}>
        <p class="wt__error" role="alert">{error()}</p>
      </Show>
      <Show when={report()}>
        {(r) => (
          <>
            <For each={r().notes}>{(n) => <p class="wt__note">{n === "timeout" ? t("webtools.deps.timeout") : n}</p>}</For>
            <Show when={r().outdated}>
              {(list) => (
                <section class="wt__sec" aria-label={t("webtools.deps.outdated")}>
                  <h4 class="wt__h2">{t("webtools.deps.outdated")} <Badge size="sm" tone={list().length ? "warn" : "ok"} numeric>{list().length}</Badge></h4>
                  <Show when={list().length === 0}>
                    <p class="wt__hint"><Icon icon={CircleCheck} size={12} /> {t("webtools.deps.upToDate")}</p>
                  </Show>
                  <ul class="wt__rows">
                    <For each={list()}>
                      {(p) => (
                        <li class="wt__row">
                          <code class="wt__name">{p.name}</code>
                          <code class="wt__val">{p.current} → {p.latest}</code>
                          <Badge size="sm" tone={p.jump === "major" ? "danger" : p.jump === "minor" ? "warn" : "info"}>{t(`webtools.deps.jump.${p.jump}`)}</Badge>
                          <Show when={p.dev}>
                            <Badge size="sm">{t("webtools.deps.dev")}</Badge>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              )}
            </Show>
            <Show when={r().audit}>
              {(a) => (
                <section class="wt__sec" aria-label={t("webtools.deps.audit")}>
                  <h4 class="wt__h2">{t("webtools.deps.audit")} <Badge size="sm" tone={a().items.length ? "danger" : "ok"} numeric>{a().items.length}</Badge></h4>
                  <Show when={a().items.length === 0}>
                    <p class="wt__hint">{t("webtools.deps.noVulns")}</p>
                  </Show>
                  <ul class="wt__rows">
                    <For each={a().items}>
                      {(v) => (
                        <li class="wt__row">
                          <code class="wt__name">{v.name}</code>
                          <Badge size="sm" tone={v.severity === "critical" || v.severity === "high" ? "danger" : "warn"}>{t(`webtools.deps.sev.${v.severity}`)}</Badge>
                          <Show when={v.direct}>
                            <Badge size="sm">{t("webtools.deps.direct")}</Badge>
                          </Show>
                          <span class="wt__hint">{t(`webtools.deps.fix.${v.fix}`)}</span>
                          <span class="wt__hint wt__grow">{v.title}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              )}
            </Show>
            <Show when={(r().outdated?.length ?? 0) + (r().audit?.items.length ?? 0) > 0}>
              <AskButton repoId={props.repoId} aria={t("webtools.deps.askAria")} label={t("webtools.deps.ask")} prompt={() => depsPrompt(r().outdated ?? [], r().audit?.items ?? [])} />
            </Show>
          </>
        )}
      </Show>

      <Dialog
        open={confirming()}
        onClose={() => setConfirming(false)}
        title={t("webtools.deps.confirmTitle")}
        description={t("webtools.deps.confirmDesc")}
        size="sm"
        role="alertdialog"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>{t("webtools.cancel")}</Button>
            <Button variant="primary" data-autofocus onClick={() => void run()}>{t("webtools.deps.confirmGo")}</Button>
          </>
        }
      >
        <ul class="wt__list">
          <li>{t("webtools.deps.confirm1")}</li>
          <li>{t("webtools.deps.confirm2")}</li>
          <li>{t("webtools.deps.confirm3")}</li>
        </ul>
      </Dialog>
    </div>
  );
}
