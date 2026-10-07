import { createResource, For, Show, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import { t } from "../../i18n";
import { toast } from "../../ui-kit";
import { imageSource, parseMarkdown, type Block, type Inline } from "./markdown";
import { readDataUrl } from "./source";

const LOCAL_IMAGE_MAX = 2 * 1024 * 1024;

interface Ctx {
  repoId: string;
  /** Folder of the document, for relative images. */
  dir: string;
}

function Img(props: { src: string; alt: string; ctx: Ctx }) {
  const source = () => imageSource(props.src, props.ctx.dir);
  const [data] = createResource(
    () => {
      const s = source();
      return s.kind === "local" ? s.path : undefined;
    },
    (path) => readDataUrl(props.ctx.repoId, path, LOCAL_IMAGE_MAX).then((r) => r.url, () => null),
  );
  return (
    <Show
      when={source().kind === "local"}
      fallback={
        <span class="md__blocked" title={props.src}>
          {props.alt ? (source().kind === "remote" ? t("viewers.md.remoteBlockedAlt", { alt: props.alt }) : t("viewers.md.blockedAlt", { alt: props.alt })) : source().kind === "remote" ? t("viewers.md.remoteBlocked") : t("viewers.md.blocked")}
        </span>
      }
    >
      <Show when={data()} fallback={<span class="md__blocked">{data.loading ? t("viewers.md.loading") : t("viewers.md.unavailable", { name: props.alt || props.src })}</span>}>
        <img src={data()!} alt={props.alt} />
      </Show>
    </Show>
  );
}

function Inlines(props: { c: Inline[]; ctx: Ctx }): JSX.Element {
  return (
    <For each={props.c}>
      {(n) => {
        switch (n.t) {
          case "text":
            return n.v;
          case "code":
            return <code>{n.v}</code>;
          case "strong":
            return (
              <strong>
                <Inlines c={n.c} ctx={props.ctx} />
              </strong>
            );
          case "em":
            return (
              <em>
                <Inlines c={n.c} ctx={props.ctx} />
              </em>
            );
          case "del":
            return (
              <del>
                <Inlines c={n.c} ctx={props.ctx} />
              </del>
            );
          case "br":
            return <br />;
          case "image":
            return <Img src={n.src} alt={n.alt} ctx={props.ctx} />;
          case "link":
            // never navigates the app: a click copies the address
            return (
              <a
                data-blocked={n.href ? undefined : ""}
                title={n.href ?? t("viewers.md.linkBlocked")}
                href={undefined}
                role="link"
                tabIndex={0}
                onClick={() => n.href && void navigator.clipboard?.writeText(n.href).then(() => toast.info(t("viewers.md.linkCopied")), () => undefined)}
              >
                <Inlines c={n.c} ctx={props.ctx} />
              </a>
            );
        }
      }}
    </For>
  );
}

function Blocks(props: { blocks: Block[]; ctx: Ctx }): JSX.Element {
  return (
    <For each={props.blocks}>
      {(b) => {
        switch (b.t) {
          case "heading": {
            return (
              <Dynamic component={`h${b.level}`}>
                <Inlines c={b.c} ctx={props.ctx} />
              </Dynamic>
            );
          }
          case "p":
            return (
              <p>
                <Inlines c={b.c} ctx={props.ctx} />
              </p>
            );
          case "code":
            return (
              <pre>
                <code data-lang={b.lang || undefined}>{b.v}</code>
              </pre>
            );
          case "hr":
            return <hr />;
          case "quote":
            return (
              <blockquote>
                <Blocks blocks={b.c} ctx={props.ctx} />
              </blockquote>
            );
          case "list": {
            const items = (
              <For each={b.items}>
                {(it) => (
                  <li data-task={it.task === null ? undefined : ""}>
                    <Show when={it.task !== null}>
                      <input type="checkbox" checked={it.task === true} disabled aria-label={it.task ? t("viewers.md.done") : t("viewers.md.notDone")} />
                    </Show>
                    <div>
                      <Blocks blocks={it.c.length === 1 && it.c[0].t === "p" ? [{ t: "p", c: it.c[0].c }] : it.c} ctx={props.ctx} />
                    </div>
                  </li>
                )}
              </For>
            );
            return b.ordered ? <ol start={b.start}>{items}</ol> : <ul>{items}</ul>;
          }
          case "table":
            return (
              <table>
                <thead>
                  <tr>
                    <For each={b.head}>
                      {(h, i) => (
                        <th style={{ "text-align": b.align[i()] ?? "left" }}>
                          <Inlines c={h} ctx={props.ctx} />
                        </th>
                      )}
                    </For>
                  </tr>
                </thead>
                <tbody>
                  <For each={b.rows}>
                    {(r) => (
                      <tr>
                        <For each={r}>
                          {(c, i) => (
                            <td style={{ "text-align": b.align[i()] ?? "left" }}>
                              <Inlines c={c} ctx={props.ctx} />
                            </td>
                          )}
                        </For>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            );
        }
      }}
    </For>
  );
}

/** Renders Markdown from its AST with Solid elements: no innerHTML anywhere, raw HTML in the text stays text. */
export function MarkdownView(props: { text: string; repoId: string; path: string }) {
  const ctx = (): Ctx => ({ repoId: props.repoId, dir: props.path.split("/").slice(0, -1).join("/") });
  return (
    <article class="md ui-selectable">
      <Blocks blocks={parseMarkdown(props.text)} ctx={ctx()} />
    </article>
  );
}
