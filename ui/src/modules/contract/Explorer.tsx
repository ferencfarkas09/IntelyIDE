import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { fmt, t } from "../../i18n";
import { errorText } from "../../store/snapshots";
import { Badge, Button, Copy, EmptyState, ExternalLink, FileJson, IconButton, Input, ListTree, Search, SegmentedControl, Select, Skeleton, toast } from "../../ui-kit";
import { openHit } from "../search/openHit";
import { repoName } from "./Findings";
import { SchemaView } from "./Schema";
import { allMethods, allTags, curlFor, exampleOf, filterEndpoints, prettyJson } from "./logic";
import { definitionOf, detailOf } from "./store";
import type { Detail, Endpoint, Report, SchemaNode } from "./types";

const METHOD_TONE: Record<string, "ok" | "info" | "warn" | "danger" | "neutral" | "accent"> = { GET: "info", POST: "ok", PUT: "warn", PATCH: "warn", DELETE: "danger" };

function Example(props: { node: SchemaNode | null }) {
  return (
    <Show when={props.node}>
      <span class="contract__sdesc">{t("contract.detail.example")}</span>
      <pre class="contract__code" aria-label={t("contract.detail.example")}>
        {prettyJson(exampleOf(props.node))}
      </pre>
    </Show>
  );
}

function SchemaBlock(props: { node: SchemaNode | null }) {
  return (
    <Show when={props.node} fallback={<p class="contract__hint">{t("contract.detail.noSchema")}</p>}>
      <SchemaView node={props.node!} />
      <p class="contract__hint">{t("contract.detail.exampleNote")}</p>
      <Example node={props.node} />
    </Show>
  );
}

function EndpointDetail(props: { report: Report; endpoint: Endpoint }) {
  const [detail] = createResource(
    () => props.endpoint.id,
    (id) => detailOf(id),
  );
  const sites = createMemo(() => props.report.clients.flatMap((c) => c.usage[props.endpoint.id] ?? []));
  async function copy(d: Detail) {
    try {
      await navigator.clipboard.writeText(curlFor(d, props.report.spec.host));
      toast.success(t("contract.curl.copied"), t("contract.curl.copiedBody"));
    } catch (e) {
      toast.error(t("contract.curl.failed"), errorText(e));
    }
  }
  const e = () => props.endpoint;
  return (
    <div class="contract__detail" data-testid="contract-detail">
      <header class="contract__dhead">
        <Badge tone={METHOD_TONE[e().method] ?? "neutral"}>{e().method}</Badge>
        <code class="contract__dpath">{e().path}</code>
        <span class="contract__spacer" />
        <IconButton icon={FileJson} size="sm" label={t("contract.openSwagger")} onClick={() => openHit(props.report.spec.repoId, e().source.file, e().source.line, 1)} />
        <Button size="sm" variant="primary" icon={Copy} disabled={!detail()} onClick={() => detail() && void copy(detail()!)}>
          {t("contract.curl.copy")}
        </Button>
      </header>
      <div class="contract__chips">
        <Show when={e().operationId}>
          <code class="contract__chip">{e().operationId}</code>
        </Show>
        <For each={e().tags}>{(tag) => <Badge size="sm">{tag}</Badge>}</For>
        <Show when={e().deprecated}>
          <Badge size="sm" tone="warn">
            {t("contract.detail.deprecated")}
          </Badge>
        </Show>
        <Show when={detail()?.secured}>
          <Badge size="sm" tone="info">
            {t("contract.detail.secured")}
          </Badge>
        </Show>
      </div>
      <Show when={e().summary}>
        <p class="contract__summary">{e().summary}</p>
      </Show>
      <Show when={detail.error}>
        <p class="contract__error" role="alert">
          {t("contract.detail.failed")}: {errorText(detail.error)}
        </p>
      </Show>
      <Show when={detail.loading}>
        <div class="contract__loading" aria-label={t("contract.detail.loading")}>
          <Skeleton height={16} />
          <Skeleton height={16} />
        </div>
      </Show>
      <Show when={detail()}>
        {(d) => (
          <>
            <Show when={d().description}>
              <p class="contract__desc">{d().description}</p>
            </Show>
            <h3 class="contract__h">{t("contract.detail.params")}</h3>
            <Show when={d().params.length} fallback={<p class="contract__hint">{t("contract.detail.noParams")}</p>}>
              <table class="contract__ptable">
                <tbody>
                  <For each={d().params}>
                    {(p) => (
                      <tr>
                        <td>
                          <code>{p.name}</code>
                        </td>
                        <td class="contract__pin">{p.in}</td>
                        <td class="contract__stype">{p.schema.type}</td>
                        <td>
                          <Show when={p.required}>
                            <Badge size="sm" tone="warn">
                              {t("contract.detail.required")}
                            </Badge>
                          </Show>
                        </td>
                        <td class="contract__sdesc">{p.description}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
            <Show when={d().request || e().hasBody}>
              <h3 class="contract__h">{t("contract.detail.requestBody")}</h3>
              <SchemaBlock node={d().request} />
            </Show>
            <h3 class="contract__h">{t("contract.detail.responses")}</h3>
            <For each={d().responses}>
              {(r) => (
                <section class="contract__resp">
                  <div class="contract__rhead">
                    <Badge size="sm" tone={r.status.startsWith("2") ? "ok" : r.status.startsWith("4") || r.status.startsWith("5") ? "danger" : "neutral"} numeric>
                      {r.status}
                    </Badge>
                    <span class="contract__sdesc">{r.description}</span>
                  </div>
                  <Show when={r.schema}>
                    <SchemaBlock node={r.schema} />
                  </Show>
                </section>
              )}
            </For>
            <p class="contract__hint">{t("contract.curl.note")}</p>
          </>
        )}
      </Show>
      <h3 class="contract__h">{t("contract.detail.usedBy")}</h3>
      <Show when={sites().length} fallback={<p class="contract__hint">{t("contract.detail.notUsed")}</p>}>
        <ul class="contract__sites">
          <For each={sites()}>
            {(s) => (
              <li>
                <span class="contract__repo">{repoName(s.repoId)}</span>
                <button type="button" class="contract__link" onClick={() => openHit(s.repoId, s.file, s.line, s.col)}>
                  {s.file}:{s.line}
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

function DefinitionDetail(props: { name: string }) {
  const [node] = createResource(
    () => props.name,
    (n) => definitionOf(n),
  );
  return (
    <div class="contract__detail" data-testid="contract-definition">
      <header class="contract__dhead">
        <code class="contract__dpath">{props.name}</code>
      </header>
      <Show when={node.error}>
        <p class="contract__error" role="alert">
          {errorText(node.error)}
        </p>
      </Show>
      <Show when={node()}>{(n) => <SchemaBlock node={n()} />}</Show>
    </div>
  );
}

/** The Explorer view: paths and definitions of the backend contract with schema viewer, generated examples and cURL. */
export default function Explorer(props: { report: Report }) {
  const [mode, setMode] = createSignal<"paths" | "definitions">("paths");
  const [text, setText] = createSignal("");
  const [method, setMethod] = createSignal("");
  const [tag, setTag] = createSignal("");
  const [picked, setPicked] = createSignal<string | undefined>(undefined);
  const [def, setDef] = createSignal<string | undefined>(undefined);
  const methods = createMemo(() => allMethods(props.report.endpoints));
  const tags = createMemo(() => allTags(props.report.endpoints));
  const list = createMemo(() => filterEndpoints(props.report.endpoints, text(), method(), tag()));
  const defs = createMemo(() => {
    const q = text().trim().toLowerCase();
    return props.report.definitions.filter((d) => !q || d.toLowerCase().includes(q));
  });
  const current = () => props.report.endpoints.find((e) => e.id === picked());
  return (
    <div class="contract__explorer">
      <div class="contract__elist">
        <SegmentedControl size="sm" aria-label={t("contract.explorer.mode")} value={mode()} onChange={setMode} options={[{ value: "paths", label: t("contract.explorer.paths") }, { value: "definitions", label: t("contract.explorer.definitions") }]} />
        <Input size="sm" aria-label={t("contract.explorer.search")} placeholder={t("contract.explorer.search")} leading={<Search size={14} aria-hidden="true" />} value={text()} onInput={(e) => setText(e.currentTarget.value)} />
        <Show when={mode() === "paths"}>
          <div class="contract__efilters">
            <Select size="sm" aria-label={t("contract.explorer.method")} value={method()} onChange={setMethod} options={[{ value: "", label: t("contract.explorer.allMethods") }, ...methods().map((m) => ({ value: m, label: m }))]} />
            <Select size="sm" aria-label={t("contract.explorer.tag")} value={tag()} onChange={setTag} options={[{ value: "", label: t("contract.explorer.allTags") }, ...tags().map((x) => ({ value: x, label: x }))]} />
          </div>
        </Show>
        <div class="contract__rows" role="listbox" aria-label={t("contract.explorer.paths")}>
          <Show when={mode() === "paths"} fallback={<For each={defs().slice(0, 400)}>{(d) => <button type="button" role="option" aria-selected={def() === d} class="contract__row" data-active={def() === d ? "" : undefined} onClick={() => setDef(d)}><span class="contract__rpath">{d}</span></button>}</For>}>
            <For each={list().rows} fallback={<EmptyState icon={Search} size="sm" title={t("contract.explorer.none")} description={t("contract.explorer.noneDesc")} />}>
              {(e) => (
                <button type="button" role="option" aria-selected={picked() === e.id} class="contract__row" data-active={picked() === e.id ? "" : undefined} data-deprecated={e.deprecated ? "" : undefined} onClick={() => setPicked(e.id)}>
                  <span class="contract__method" data-method={e.method}>
                    {e.method}
                  </span>
                  <span class="contract__rpath">{e.path}</span>
                </button>
              )}
            </For>
          </Show>
        </div>
        <Show when={mode() === "paths" && list().total > list().rows.length}>
          <p class="contract__hint">{t("contract.explorer.shown", { shown: fmt.number(list().rows.length), total: fmt.number(list().total) })}</p>
        </Show>
      </div>
      <div class="contract__epane">
        <Show
          when={mode() === "paths" ? current() : def()}
          fallback={<EmptyState icon={ListTree} size="sm" title={t("contract.explorer.pick")} description={t("contract.explorer.pickDesc")} />}
        >
          <Show when={mode() === "paths"} fallback={<DefinitionDetail name={def()!} />}>
            <EndpointDetail report={props.report} endpoint={current()!} />
          </Show>
        </Show>
      </div>
    </div>
  );
}
