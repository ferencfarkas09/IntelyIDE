import { createMemo, createSignal, For, Show } from "solid-js";
import { t, type MessageKey } from "../../i18n";
import { Badge, Button, Check, Dialog, Icon, Input, Search } from "../../ui-kit";
import { CATALOG, CATEGORIES, matchesCatalog, needsNode, needsSecret, type CatalogCategory, type CatalogEntry } from "./catalog";

export interface CatalogDialogProps {
  open: boolean;
  /** Names of the servers that exist now: an entry whose name is among them is marked as added (adding it again gets the next free name). */
  existingNames: readonly string[];
  onClose: () => void;
  onPick: (entry: CatalogEntry) => void;
}

const CATEGORY_KEY: Record<CatalogCategory, MessageKey> = {
  code: "mcp.catalog.cat.code",
  browser: "mcp.catalog.cat.browser",
  docs: "mcp.catalog.cat.docs",
  data: "mcp.catalog.cat.data",
  search: "mcp.catalog.cat.search",
  design: "mcp.catalog.cat.design",
};

/**
 * The catalog of ready-made servers. It only chooses: the editor opens with the entry filled in, and the usual save and
 * confirmation follow. The list is data (`catalog.ts`), so nothing here starts, saves or contacts anything.
 */
export function CatalogDialog(props: CatalogDialogProps) {
  const [query, setQuery] = createSignal("");
  const has = (id: string) => props.existingNames.some((n) => n.toLowerCase() === id);
  const groups = createMemo(() =>
    CATEGORIES.map((category) => ({ category, entries: CATALOG.filter((e) => e.category === category && matchesCatalog(e, query(), t(e.summary))) })).filter((g) => g.entries.length > 0),
  );
  const close = () => {
    setQuery("");
    props.onClose();
  };
  return (
    <Dialog open={props.open} onClose={close} size="lg" title={t("mcp.catalog.title")} description={t("mcp.catalog.intro")}>
      <div class="mcp-cat">
        <Input
          size="sm"
          data-autofocus
          aria-label={t("mcp.catalog.search")}
          placeholder={t("mcp.catalog.search")}
          leading={<Icon icon={Search} size={12} />}
          autocomplete="off"
          spellcheck={false}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <For each={groups()} fallback={<p class="mcp-cat__none" role="status">{t("mcp.catalog.none", { query: query() })}</p>}>
          {(g) => (
            <section class="mcp-cat__group" aria-label={t(CATEGORY_KEY[g.category])}>
              <h3 class="mcp-cat__cat">{t(CATEGORY_KEY[g.category])}</h3>
              <ul class="mcp-cat__list" role="list">
                <For each={g.entries}>
                  {(e) => (
                    <li class="mcp-cat__row" aria-label={e.title}>
                      <span class="mcp-cat__icon" aria-hidden="true"><Icon icon={e.icon} size={16} /></span>
                      <div class="mcp-cat__body">
                        <div class="mcp-cat__title">
                          <span>{e.title}</span>
                          <Badge size="sm" tone="neutral">{t(e.transport === "http" ? "mcp.transport.http" : "mcp.transport.stdio")}</Badge>
                          <Show when={has(e.id)}><Badge size="sm" tone="ok" icon={Check}>{t("mcp.catalog.added")}</Badge></Show>
                        </div>
                        <p class="mcp-cat__summary">{t(e.summary)}</p>
                        <div class="mcp-cat__meta">
                          <Show when={e.readOnly}><Badge size="sm" tone="info">{t("mcp.catalog.badge.readOnly")}</Badge></Show>
                          <Show when={needsNode(e)}><Badge size="sm" tone="neutral">{t("mcp.catalog.badge.node")}</Badge></Show>
                          <Show when={needsSecret(e)}><Badge size="sm" tone="warn">{t("mcp.catalog.badge.secret")}</Badge></Show>
                        </div>
                      </div>
                      <Button size="sm" variant="secondary" aria-label={t("mcp.catalog.add", { name: e.title })} onClick={() => props.onPick(e)}>{t("mcp.catalog.addShort")}</Button>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          )}
        </For>
      </div>
    </Dialog>
  );
}
