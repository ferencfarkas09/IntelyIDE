import { createMemo, createSignal, For, Show } from "solid-js";
import { t, type MessageKey } from "../../i18n";
import { tRich } from "../../components/richText";
import { Badge, Icon, IconButton, Input, Lock, RefreshCw, Search, Spinner } from "../../ui-kit";
import { currentUrl, openPage, urlForPage } from "./actions";
import { filterPages, kindName, KIND_START, type PageEntry, type PageKind } from "./catalog";
import { catalogOf, refreshCatalog } from "./state";

const TITLES = { login: "pv.pages.login", list: "pv.pages.list", other: "pv.pages.other" } as const satisfies Record<PageKind, MessageKey>;

export interface PageListProps {
  repoId: string;
  onOpened?: () => void;
  onError?: (message: string | undefined) => void;
}

/** The quick-list: login pages first, then list pages, then the rest (collapsed), derived from the repo's route tables. */
export function PageList(props: PageListProps) {
  const [query, setQuery] = createSignal("");
  const [showOther, setShowOther] = createSignal(false);
  const catalog = () => {
    const c = catalogOf(props.repoId);
    return c === "loading" ? undefined : c;
  };
  const loading = () => catalogOf(props.repoId) === "loading" || catalogOf(props.repoId) === undefined;
  const filtered = createMemo(() => filterPages(catalog()?.pages ?? [], query()));
  const group = (k: PageKind) => filtered().filter((p) => p.kind === k);
  const active = (p: PageEntry) => {
    const u = urlForPage(props.repoId, p);
    const cur = currentUrl(props.repoId);
    if (!u || !cur) return false;
    return p.deepLink ? cur.split(/[?#]/)[0].replace(/\/$/, "") === u.replace(/\/$/, "") : false;
  };

  async function open(p: PageEntry): Promise<void> {
    const r = await openPage(props.repoId, p);
    if (r === undefined) props.onError?.(t("pv.pages.needsId", { link: p.link }));
    else if (!r.ok) props.onError?.(r.message);
    else {
      props.onError?.(undefined);
      props.onOpened?.();
    }
  }

  const Row = (p: { page: PageEntry }) => (
    <li>
      <button
        type="button"
        class="pv-page"
        classList={{ "pv-page--active": active(p.page) }}
        disabled={p.page.params.length > 0}
        title={p.page.params.length > 0 ? t("pv.pages.needsIdTip", { link: p.page.link }) : p.page.deepLink ? p.page.link : t("pv.pages.expoNoUrl")}
        aria-current={active(p.page) ? "page" : undefined}
        onClick={() => void open(p.page)}
      >
        <span class="pv-page__name">{p.page.name}</span>
        <Show when={p.page.deepLink} fallback={<Badge size="sm">{t("pv.pages.root")}</Badge>}>
          <code class="pv-page__link">{p.page.link}</code>
        </Show>
        <Show when={p.page.auth}>
          <span class="pv-page__lock" title={t("pv.pages.authTip")} aria-label={t("pv.pages.authLabel")}>
            <Icon icon={Lock} size={12} />
          </span>
        </Show>
      </button>
    </li>
  );

  return (
    <div class="pv-pages">
      <div class="pv-pages__head">
        <Input size="sm" aria-label={t("pv.pages.filter")} placeholder={t("pv.pages.filter")} leading={<Icon icon={Search} size={12} />} value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
        <IconButton icon={RefreshCw} size="sm" label={t("pv.pages.rescan")} loading={loading()} onClick={() => void refreshCatalog(props.repoId, true)} />
      </div>
      <Show when={!loading()} fallback={<div class="pv-pages__note pv-pages__note--row"><Spinner size={14} /> {t("pv.pages.reading")}</div>}>
        <Show
          when={(catalog()?.pages.length ?? 0) > 0}
          fallback={
            <p class="pv-pages__note">
              {catalog() && catalog()!.kind !== "unknown" ? t("pv.pages.none", { kind: kindName(catalog()!.kind) }) : t("pv.pages.noneUnknown")}
            </p>
          }
        >
          <div class="pv-pages__scroll">
            <For each={["login", "list"] as const}>
              {(k) => (
                <Show when={group(k).length > 0}>
                  <section class="pv-pages__group">
                    <h4>{t(TITLES[k])}</h4>
                    <ul>
                      <For each={group(k)}>{(page) => <Row page={page} />}</For>
                    </ul>
                  </section>
                </Show>
              )}
            </For>
            <Show when={group("other").length > 0}>
              <section class="pv-pages__group">
                <h4>
                  <button type="button" class="pv-pages__toggle" aria-expanded={showOther() || query() !== ""} onClick={() => setShowOther(!showOther())}>
                    {t(TITLES.other)} <span class="ui-tnum">({group("other").length})</span>
                  </button>
                </h4>
                <Show when={showOther() || query() !== ""}>
                  <ul>
                    <For each={group("other")}>{(page) => <Row page={page} />}</For>
                  </ul>
                </Show>
              </section>
            </Show>
          </div>
          <div class="pv-pages__note">
            <p>
              {t(catalog()!.kind === "expo" ? "pv.pages.summaryFolders" : "pv.pages.summaryFiles", { routes: catalog()!.pages.length, sources: catalog()!.scanned.length })}
            </p>
            <Show when={catalog()!.kind !== "unknown"}>
              <p>
                {tRich("pv.pages.startServer", { command: <code>{KIND_START[catalog()!.kind as keyof typeof KIND_START]}</code> })}
              </p>
            </Show>
          </div>
        </Show>
      </Show>
    </div>
  );
}
