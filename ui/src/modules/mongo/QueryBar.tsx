import { createSignal, Show } from "solid-js";
import { t } from "../../i18n";
import { Button, ChevronDown, ChevronRight, Input, Play, RotateCw } from "../../ui-kit";
import { CodeEditor, type CodeEditorHandle } from "../../ui-kit/CodeEditor";
import { completionSource } from "./completion";
import type { CollectionModel } from "./model";

export interface QueryBarProps {
  m: CollectionModel;
  /** The tenant lock field: queries must constrain it, so the placeholder shows how. */
  tenantLock?: string | null;
  /** Mod+Shift+Enter and Enter in a field: run the generated query when one waits for review, else Find. */
  onSubmit: () => void;
  filterRef?: (h: CodeEditorHandle) => void;
}

/** Filter, Project, Sort (CodeMirror 6 with schema-aware completion), Skip and Limit, Reset and Find. One-line aria-live lint underneath. */
export function QueryBar(props: QueryBarProps) {
  const m = () => props.m;
  const digest = () => m().digest();
  const changed = (k: "filter" | "projection" | "sort" | "limit") => (m().ai.changed().has(k) ? "" : undefined);
  const bad = (r: { ok: boolean }) => !r.ok;
  // Project, Sort, Skip and Limit stay behind "Options" until they hold something (or the AI filled them): the grid keeps the room.
  const [open, setOpen] = createSignal(false);
  const filled = () => {
    const f = m().q();
    return !!(f.projection.trim() || f.sort.trim() || f.skip.trim() || f.limit.trim());
  };
  const showOptions = () => open() || filled();
  return (
    <div class="mg-query">
      <div class="mg-query__row">
        <label class="mg-field mg-field--filter" data-changed={changed("filter")}>
          <span class="mg-field__label">{t("mongoLoud.query.filter")}</span>
          <span class="mg-field__box">
            <CodeEditor ref={props.filterRef} label={t("mongoLoud.query.filter")} value={m().q().filter} onChange={(v) => m().setField("filter", v)} placeholder={props.tenantLock ? `{ ${props.tenantLock}: ObjectId("…") }` : "{ status: 'open' }"} submitOnEnter onSubmit={props.onSubmit} completions={completionSource(digest, "filter")} invalid={bad(m().lints().filter)} />
          </span>
        </label>
        <div class="mg-query__buttons">
          <Button size="sm" variant="ghost" icon={showOptions() ? ChevronDown : ChevronRight} aria-expanded={showOptions()} aria-controls="mg-query-options" onClick={() => setOpen(!showOptions())}>{t("mongoLoud.query.options")}</Button>
          <Button size="sm" variant="ghost" icon={RotateCw} onClick={() => void m().reset()}>{t("mongoLoud.query.reset")}</Button>
          <Button size="sm" variant="primary" icon={Play} loading={m().status() === "loading"} onClick={() => void m().run()}>
            {t("mongoLoud.query.find")}
          </Button>
        </div>
      </div>
      <div class="mg-query__row mg-query__row--sub" id="mg-query-options" hidden={!showOptions()}>
        <label class="mg-field mg-field--project" data-changed={changed("projection")}>
          <span class="mg-field__label">{t("mongoLoud.query.project")}</span>
          <span class="mg-field__box">
            <CodeEditor label={t("mongoLoud.query.project")} value={m().q().projection} onChange={(v) => m().setField("projection", v)} placeholder={"{ total: 1 }" /* i18n-ignore */} wrap={false} submitOnEnter onSubmit={props.onSubmit} completions={completionSource(digest, "projection")} invalid={bad(m().lints().projection)} />
          </span>
        </label>
        <label class="mg-field mg-field--sort" data-changed={changed("sort")}>
          <span class="mg-field__label">{t("mongoLoud.query.sort")}</span>
          <span class="mg-field__box">
            <CodeEditor label={t("mongoLoud.query.sort")} value={m().q().sort} onChange={(v) => m().setField("sort", v)} placeholder={"{ createdAt: -1 }" /* i18n-ignore */} wrap={false} submitOnEnter onSubmit={props.onSubmit} completions={completionSource(digest, "sort")} invalid={bad(m().lints().sort)} />
          </span>
        </label>
        <label class="mg-field mg-field--num">
          <span class="mg-field__label">{t("mongoLoud.query.skip")}</span>
          <Input size="sm" aria-label={t("mongoLoud.query.skip")} inputmode="numeric" placeholder="0" value={m().q().skip} onInput={(e) => m().setField("skip", e.currentTarget.value.replace(/\D/g, ""))} onKeyDown={(e) => e.key === "Enter" && props.onSubmit()} />
        </label>
        <label class="mg-field mg-field--num" data-changed={changed("limit")}>
          <span class="mg-field__label">{t("mongoLoud.query.limit")}</span>
          <Input size="sm" aria-label={t("mongoLoud.query.limit")} inputmode="numeric" placeholder={t("mongoLoud.query.none")} value={m().q().limit} onInput={(e) => m().setField("limit", e.currentTarget.value.replace(/\D/g, ""))} onKeyDown={(e) => e.key === "Enter" && props.onSubmit()} />
        </label>
      </div>
      <div class="mg-query__lint" role="status" aria-live="polite" data-idle={m().firstProblem() ? undefined : ""}>
        <Show when={m().firstProblem()} fallback={<span class="ui-text-3">{t("mongoLoud.query.hint", { chord: "⌘⇧↵" })}</span>}>
          {(p) => <span class="mg-query__bad">{p()}</span>}
        </Show>
      </div>
    </div>
  );
}
