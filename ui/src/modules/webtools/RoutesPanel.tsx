import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { errorText } from "../../store/snapshots";
import { Badge, Button, EmptyState, Input, RefreshCw, Select, SendHorizontal, Server, Skeleton, TextArea } from "../../ui-kit";
import { webtoolsApi } from "./api";
import { livePorts, normalizePath, routesPrompt } from "./logic";
import { AskButton, createLoad, FileLink } from "./shared";
import type { LiveServer, Route, TryResponse } from "./types";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
const tone = (m: string) => (m === "GET" ? "ok" : m === "DELETE" ? "danger" : m === "ALL" || m === "ANY" ? "neutral" : "info");

/** Lines `Name: value` -> pairs; a line without a colon is ignored. Names and values are checked again by the backend. */
export function parseHeaders(text: string): [string, string][] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l): [string, string] | undefined => {
      const i = l.indexOf(":");
      return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : undefined;
    })
    .filter((x): x is [string, string] => !!x);
}

export default function RoutesPanel(props: { repoId: string }) {
  const load = createLoad(() => webtoolsApi().routes(props.repoId));
  const servers = createLoad(() => webtoolsApi().servers());
  onMount(() => (void load.run(), void servers.run()));
  const [filter, setFilter] = createSignal("");
  const [method, setMethod] = createSignal<string>("GET");
  const [path, setPath] = createSignal("/");
  const [port, setPort] = createSignal<string>("");
  const [headers, setHeaders] = createSignal("");
  const [body, setBody] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [response, setResponse] = createSignal<TryResponse>();
  const [sendError, setSendError] = createSignal<string>();

  const shown = createMemo(() => {
    const q = filter().trim().toLowerCase();
    return (load.data()?.routes ?? []).filter((r) => !q || `${r.method} ${r.path} ${r.file}`.toLowerCase().includes(q));
  });
  const ports = createMemo(() => livePorts(servers.data() ?? []));
  const portOf = () => (ports().includes(Number(port())) ? Number(port()) : ports()[0]);
  const label = (s: LiveServer, p: number) => `${s.runner} · localhost:${p}`;
  const options = createMemo(() => (servers.data() ?? []).flatMap((s) => s.ports.map((p) => ({ value: String(p), label: label(s, p) }))));

  const tryRoute = (r: Route) => {
    setMethod(METHODS.includes(r.method as (typeof METHODS)[number]) ? r.method : "GET");
    setPath(r.path === "*" ? "/" : r.path);
    document.getElementById("wt-try")?.scrollIntoView?.({ block: "nearest" });
  };

  async function send() {
    const p = normalizePath(path());
    const target = portOf();
    if (!p) return setSendError(t("webtools.try.badPath"));
    if (target === undefined) return setSendError(t("webtools.try.noServer"));
    setSending(true);
    setSendError(undefined);
    setResponse(undefined);
    try {
      setResponse(await webtoolsApi().tryIt({ port: target, method: method(), path: p, headers: parseHeaders(headers()), body: body() || undefined }));
    } catch (e) {
      setSendError(errorText(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <div class="wt__panel" data-testid="wt-routes">
      <header class="wt__phead">
        <h3 class="wt__h">{t("webtools.routes.title")}</h3>
        <Badge size="sm" tone="info">{t("webtools.heuristic")}</Badge>
        <span class="wt__spacer" />
        <Button size="sm" variant="ghost" icon={RefreshCw} loading={load.loading()} onClick={() => (void load.run(), void servers.run())}>
          {t("webtools.refresh")}
        </Button>
      </header>
      <p class="wt__hint">{t("webtools.routes.intro")}</p>
      <Show when={load.error()}>
        <p class="wt__error" role="alert">{load.error()}</p>
      </Show>
      <Show when={load.data()} fallback={<Show when={!load.error()}><Skeleton height={22} /></Show>}>
        {(r) => (
          <>
            <Show when={r().routes.length === 0}>
              <EmptyState icon={Server} size="sm" title={t("webtools.routes.none")} description={t("webtools.routes.noneDesc")} />
            </Show>
            <Show when={r().routes.length > 0}>
              <div class="wt__phead">
                <Input size="sm" wrapperClass="wt__filter" aria-label={t("webtools.routes.filter")} placeholder={t("webtools.routes.filter")} value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
                <span class="wt__hint">{t("webtools.routes.count", { count: shown().length, frameworks: r().frameworks.join(", ") })}</span>
                <span class="wt__spacer" />
                <AskButton repoId={props.repoId} aria={t("webtools.routes.askAria")} label={t("webtools.routes.ask")} prompt={() => routesPrompt(r())} />
              </div>
              <ul class="wt__rows">
                <For each={shown()}>
                  {(route) => (
                    <li class="wt__row">
                      <Badge size="sm" tone={tone(route.method)}>{route.method}</Badge>
                      <code class="wt__name">{route.path}</code>
                      <span class="wt__spacer" />
                      <FileLink repoId={props.repoId} path={route.file} line={route.line} />
                      <Button size="sm" variant="ghost" aria-label={t("webtools.routes.tryAria", { method: route.method, path: route.path })} onClick={() => tryRoute(route)}>
                        {t("webtools.routes.try")}
                      </Button>
                    </li>
                  )}
                </For>
              </ul>
              <p class="wt__hint">{t("webtools.routes.caveat")}</p>
            </Show>
            <For each={r().skipped}>{(s) => <p class="wt__note">{s}</p>}</For>
          </>
        )}
      </Show>

      <section class="wt__sec" id="wt-try" aria-label={t("webtools.try.title")} data-testid="wt-try">
        <h4 class="wt__h2">{t("webtools.try.title")}</h4>
        <p class="wt__why">{t("webtools.try.intro")}</p>
        <Show when={ports().length > 0} fallback={<EmptyState icon={Server} size="sm" title={t("webtools.try.noServer")} description={t("webtools.try.noServerDesc")} />}>
          <div class="wt__tryrow">
            <Select size="sm" aria-label={t("webtools.try.server")} options={options()} value={String(portOf())} onChange={setPort} />
            <Select size="sm" aria-label={t("webtools.try.method")} options={METHODS.map((m) => ({ value: m, label: m }))} value={method()} onChange={setMethod} />
            <Input size="sm" wrapperClass="wt__path" aria-label={t("webtools.try.path")} placeholder="/api/users" spellcheck={false} value={path()} onInput={(e) => setPath(e.currentTarget.value)} />
            <Button size="sm" variant="primary" icon={SendHorizontal} loading={sending()} onClick={() => void send()}>
              {t("webtools.try.send")}
            </Button>
          </div>
          <details class="wt__more">
            <summary>{t("webtools.try.options")}</summary>
            <label class="wt__field wt__field--col">
              <span class="wt__hint">{t("webtools.try.headers")}</span>
              <TextArea minRows={2} maxRows={6} spellcheck={false} aria-label={t("webtools.try.headers")} placeholder="Authorization: Bearer ..." value={headers()} onInput={(e) => setHeaders(e.currentTarget.value)} />
            </label>
            <label class="wt__field wt__field--col">
              <span class="wt__hint">{t("webtools.try.body")}</span>
              <TextArea minRows={2} maxRows={8} spellcheck={false} aria-label={t("webtools.try.body")} value={body()} onInput={(e) => setBody(e.currentTarget.value)} />
            </label>
          </details>
          <p class="wt__hint">{t("webtools.try.loopback")}</p>
        </Show>
        <Show when={sendError()}>
          <p class="wt__error" role="alert">{sendError()}</p>
        </Show>
        <Show when={response()}>
          {(res) => (
            <div class="wt__resp" data-testid="wt-response">
              <p class="wt__stat">
                <Badge size="sm" tone={res().status < 400 ? "ok" : "danger"}>{res().status} {res().reason}</Badge>
                <span class="wt__hint">{t("webtools.try.took", { ms: res().millis, bytes: res().bytes, host: res().host })}</span>
              </p>
              <Show when={res().redirect}>
                <p class="wt__note">{t("webtools.try.redirect", { to: res().redirect ?? "" })}</p>
              </Show>
              <details class="wt__more">
                <summary>{t("webtools.try.respHeaders", { count: res().headers.length })}</summary>
                <pre class="wt__pre">{res().headers.map(([k, v]) => `${k}: ${v}`).join("\n")}</pre>
              </details>
              <Show when={res().binary} fallback={<pre class="wt__pre" aria-label={t("webtools.try.respBody")}>{res().body}</pre>}>
                <p class="wt__hint">{t("webtools.try.binary", { bytes: res().bytes })}</p>
              </Show>
              <Show when={res().bodyTruncated}>
                <p class="wt__note">{t("webtools.try.truncated")}</p>
              </Show>
            </div>
          )}
        </Show>
      </section>
    </div>
  );
}
