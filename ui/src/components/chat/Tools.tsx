import type { LucideIcon } from "lucide-solid";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import type { NoteItem, ToolItem } from "../../store/agent-reducer";
import type { DelegateInfo, ToolKind, ToolStatus } from "../../store/agent-types";
import { Badge, Ban, Brain, Button, Check, ChevronRight, CircleAlert, Globe, Icon, Layers, Pencil, Search, Spinner, SquareTerminal, Trash2, ArrowRight, FileSearch, Wrench, X } from "../../ui-kit";
import { diffLines } from "./diffLines";
import { t } from "../../i18n";
import { lazyLabels } from "../lazyLabels";
import { fmtDuration, modelLabel, subagentRole } from "./format";
import { NoteInput, NoteRow } from "./Notes";

const KIND_ICON: Record<ToolKind, LucideIcon> = {
  read: FileSearch,
  edit: Pencil,
  delete: Trash2,
  move: ArrowRight,
  search: Search,
  exec: SquareTerminal,
  fetch: Globe,
  think: Brain,
  mcp: Layers,
  other: Wrench,
};

const STATUS_LABEL = lazyLabels<ToolStatus>({ running: "chat.tool.running", ok: "chat.tool.ok", error: "chat.tool.error", denied: "chat.tool.denied", cancelled: "chat.tool.cancelled" });
const PREVIEW_LINES = 12;
const OUTPUT_LIMIT = 6000;

const PATH_KINDS = new Set<ToolKind>(["read", "edit", "delete", "move"]);

/** A path summary keeps its file name when the line is too narrow: the directory part shortens first. */
export function splitPath(summary: string): [dir: string, base: string] {
  const at = summary.lastIndexOf("/");
  return at < 0 || at === summary.length - 1 ? ["", summary] : [summary.slice(0, at + 1), summary.slice(at + 1)];
}

export function ToolStatusMark(props: { status: ToolStatus }) {
  return (
    <span class="tool-status" data-status={props.status} title={STATUS_LABEL[props.status]}>
      <Switch>
        <Match when={props.status === "running"}>
          <Spinner size={12} />
        </Match>
        <Match when={props.status === "ok"}>
          <Icon icon={Check} size={12} />
        </Match>
        <Match when={props.status === "error"}>
          <Icon icon={CircleAlert} size={12} />
        </Match>
        <Match when={props.status === "denied"}>
          <Icon icon={Ban} size={12} />
        </Match>
        <Match when={props.status === "cancelled"}>
          <Icon icon={X} size={12} />
        </Match>
      </Switch>
      <span class="ui-sr-only">{STATUS_LABEL[props.status]}</span>
    </span>
  );
}

export function DiffPreview(props: { path: string; old: string; new: string }) {
  const lines = createMemo(() => diffLines(props.old, props.new));
  const [all, setAll] = createSignal(false);
  const shown = () => (all() ? lines() : lines().slice(0, PREVIEW_LINES));
  const hidden = () => lines().length - PREVIEW_LINES;
  const counts = createMemo(() => ({ add: lines().filter((l) => l.kind === "add").length, del: lines().filter((l) => l.kind === "del").length }));
  return (
    <div class="dpv" role="group" aria-label={t("chat.tool.changesTo", { path: props.path })}>
      <div class="dpv__head">
        <span class="ui-mono ui-truncate">{props.path}</span>
        <span class="dpv__counts ui-tnum">
          <span class="dpv__add">+{counts().add}</span> <span class="dpv__del">−{counts().del}</span>
        </span>
      </div>
      <pre class="dpv__body ui-selectable">
        <For each={shown()}>
          {(l) => (
            <span class="dpv__line" data-kind={l.kind}>
              <span class="dpv__sign" aria-hidden="true">
                {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
              </span>
              {l.text}
              {"\n"}
            </span>
          )}
        </For>
      </pre>
      <Show when={!all() && hidden() > 0}>
        <Button variant="ghost" size="sm" class="dpv__more" onClick={() => setAll(true)}>
          {t("chat.tool.showMore", { n: hidden() })}
        </Button>
      </Show>
    </div>
  );
}

function ToolBody(props: { item: ToolItem }) {
  const out = () => (props.item.output && props.item.output.length > OUTPUT_LIMIT ? `${props.item.output.slice(0, OUTPUT_LIMIT)}\n${t("chat.tool.moreChars", { n: props.item.output.length - OUTPUT_LIMIT })}` : props.item.output);
  return (
    <div class="tool-card__body">
      <Show when={props.item.diff}>{(d) => <DiffPreview path={d().path} old={d().old ?? ""} new={d().new} />}</Show>
      <Show when={out()}>
        <pre class="tool-card__out ui-selectable" data-error={props.item.status === "error" ? "" : undefined}>
          {out()}
        </pre>
      </Show>
    </div>
  );
}

/** One tool call: collapsed to a line, expandable to its output or diff. Subagent children nest under it. */
export function ToolCard(props: {
  item: ToolItem;
  children?: ToolItem[];
  nested?: boolean;
  /** The run's role table: names the role (and its model) an Agent call starts. */
  delegates?: DelegateInfo[];
  /** Notes the user added to the subagent this call started. */
  notes?: NoteItem[];
  /** Present while a note can be added to this subagent (the run takes notes and is working): adds one, rejects when the host refuses it. */
  onNote?: (text: string) => Promise<void>;
  /** Present while a note whose subagent had already finished can still be said to the lead. */
  onNoteToLead?: (text: string) => void;
}) {
  const role = () => subagentRole(props.item.name, props.item.input);
  const delegate = () => props.delegates?.find((d) => d.name === role());
  const hasBody = () => !!(props.item.diff || props.item.output);
  const subagent = () => (props.children?.length ?? 0) > 0;
  // Edits show their diff and failures show why, as soon as that arrives; until the user toggles, everything else stays one line.
  const [manual, setManual] = createSignal<boolean | undefined>(undefined);
  const open = () => manual() ?? (!!props.item.diff || props.item.status === "error");
  const expandable = () => hasBody() || subagent();
  const noteable = () => !!props.onNote && (props.item.name === "Agent" || props.item.name === "Task") && props.item.status === "running";
  return (
    <div class="tool-card" data-kind={props.item.toolKind} data-status={props.item.status} data-nested={props.nested ? "" : undefined}>
      <button type="button" class="tool-card__head" aria-expanded={expandable() ? open() : undefined} disabled={!expandable()} onClick={() => setManual(!open())}>
        <span class="tool-card__chev" data-open={open() ? "" : undefined} data-hidden={expandable() ? undefined : ""}>
          <Icon icon={ChevronRight} size={12} />
        </span>
        <span class="tool-card__icon">
          <Icon icon={KIND_ICON[props.item.toolKind]} size={14} />
        </span>
        <span class="tool-card__name">{subagent() ? t("chat.tool.subagent") : props.item.name}</span>
        <Show when={role()}>
          {(r) => (
            <span class="tool-card__role" title={delegate()?.description ?? r()}>
              <span class="tool-card__swatch" style={{ background: delegate()?.color ?? "var(--text-4)" }} aria-hidden="true" />
              {r()}
              <Show when={delegate()}>{(d) => <Badge size="sm">{modelLabel(d().model)}</Badge>}</Show>
            </span>
          )}
        </Show>
        <span class="tool-card__summary ui-mono" title={props.item.summary}>
          <Show when={PATH_KINDS.has(props.item.toolKind) && props.item.summary} fallback={<span class="tool-card__base">{props.item.summary}</span>}>
            {(s) => (
              <>
                <span class="tool-card__dir">{splitPath(s())[0]}</span>
                <span class="tool-card__base">{splitPath(s())[1]}</span>
              </>
            )}
          </Show>
        </span>
        <Show when={subagent()}>
          <span class="tool-card__count ui-tnum">{t("chat.tool.calls", { n: props.children!.length })}</span>
        </Show>
        <Show when={props.item.durationMs !== undefined && props.item.status !== "running"}>
          <span class="tool-card__time ui-tnum">{fmtDuration(props.item.durationMs!)}</span>
        </Show>
        <ToolStatusMark status={props.item.status} />
      </button>
      <Show when={(props.notes?.length ?? 0) > 0 || noteable()}>
        <div class="tool-card__notes">
          <For each={props.notes}>{(n) => <NoteRow item={n} nested onSendToLead={props.onNoteToLead} />}</For>
          <Show when={noteable()}>
            <NoteInput label={t("notes.inputSub")} onSend={props.onNote!} />
          </Show>
        </div>
      </Show>
      <Show when={open() && expandable()}>
        <Show when={hasBody()}>
          <ToolBody item={props.item} />
        </Show>
        <Show when={subagent()}>
          <div class="tool-card__kids">
            <For each={props.children}>{(child) => <ToolCard item={child} nested delegates={props.delegates} />}</For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
