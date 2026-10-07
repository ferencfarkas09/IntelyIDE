import { createSignal, createEffect, For, on, Show, Suspense, ErrorBoundary } from "solid-js";
import { Dynamic } from "solid-js/web";
import { t } from "../../i18n";
import { Dialog, EmptyState, Icon, Input, Search, Settings, Spinner, TriangleAlert } from "../../ui-kit";
import { activeSettingsSection, closeSettings, filterSections, selectSettingsSection, settingsOpen, settingsSections } from "../settings";
import "./platform.css";

export function SettingsDialog() {
  const [query, setQuery] = createSignal("");
  createEffect(on(settingsOpen, (o) => o && setQuery("")));
  const sections = () => filterSections(query());
  const current = () => {
    const active = activeSettingsSection();
    return active && sections().some((s) => s.id === active.id) ? active : sections()[0];
  };

  return (
    <Dialog open={settingsOpen()} onClose={closeSettings} title={t("settings.title")} size="xl" class="settings">
      <Show
        when={settingsSections().length}
        fallback={<EmptyState icon={Settings} title={t("settings.emptyTitle")} description={t("settings.emptyText")} />}
      >
        <div class="settings__layout">
          <nav class="settings__nav" aria-label={t("settings.sections")}>
            <Input
              size="sm"
              aria-label={t("settings.search")}
              placeholder={t("settings.search")}
              autocomplete="off"
              leading={<Icon icon={Search} size={14} />}
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
            <ul class="settings__list">
              <For each={sections()} fallback={<li class="settings__none">{t("settings.none")}</li>}>
                {(s) => (
                  <li>
                    <button type="button" class="settings__item" aria-current={current()?.id === s.id ? "page" : undefined} onClick={() => selectSettingsSection(s.id)}>
                      <Show when={s.icon}>{(i) => <Icon icon={i()} size={14} />}</Show>
                      <span class="ui-truncate">{s.title}</span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </nav>
          <section class="settings__pane" aria-label={current()?.title}>
            <Show when={current()} fallback={<EmptyState size="sm" icon={Search} title={t("settings.noMatchTitle")} description={t("settings.noMatchText")} />}>
              {(section) => (
                <>
                  <h3 class="settings__title">{section().title}</h3>
                  <ErrorBoundary fallback={(err) => <EmptyState tone="danger" icon={TriangleAlert} size="sm" title={t("settings.loadFailed", { section: section().title })} description={err instanceof Error ? err.message : String(err)} />}>
                    <Suspense fallback={<div class="settings__loading"><Spinner /></div>}>
                      <Dynamic component={section().component} />
                    </Suspense>
                  </ErrorBoundary>
                </>
              )}
            </Show>
          </section>
        </div>
      </Show>
    </Dialog>
  );
}
