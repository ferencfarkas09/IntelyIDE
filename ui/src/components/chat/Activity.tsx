import { createMemo, createSignal, For, type JSX, Match, Show, Switch } from "solid-js";
import type { ToolItem, TranscriptRow } from "../../store/agent-reducer";
import type { ToolKind } from "../../store/agent-types";
import { failingKeys, VERB_ORDER, type ToolGroup } from "../../store/toolGroups";
import { Ban, ChevronRight, CircleAlert, Icon, Spinner, X } from "../../ui-kit";
import { t, type MessageKey } from "../../i18n";
import { ThinkingBlock } from "./Cards";
import { CopyButton } from "./Bubbles";
import { diffLines } from "./diffLines";
import { fmtDuration } from "./format";
import { DiffPreview, KIND_ICON, splitPath } from "./Tools";

/**
 * Compact tool activity (Settings > Appearance > Tool activity: Compact). The calls between two pieces of the agent's prose are
 * ONE quiet row: "Read 4 files, searched 2 times, ran 3 commands" with a chevron. While the group works the row is one live line
 * with the newest step; once it is done it is folded. Opened, it lists one line per call ("Ran `pnpm test`", "Edited `a.ts` +12 −3"),
 * and each line opens on its own to the command, the output or the diff. A failure, a blocked call or a call that waits for the
 * person is never hidden: the row says so (dot and words), the group starts open and the failing line starts open.
 *
 * Open/closed is held by the transcript (`isOpen`/`toggle`), keyed by the group's or the call's key, so it survives the
 * virtualiser dropping the row while it is off screen. A folded group renders no line of its body.
 */

/** Lines a group shows before "Show N more steps" (the failing ones are always shown). */
export const GROUP_PAGE = 60;
const OUTPUT_LIMIT = 6000;
const PATH_KINDS = new Set<ToolKind>(["read", "edit", "delete", "move"]);

export interface OpenState {
  /** The person's choice for a key, if they made one. */
  isOpen(key: string): boolean | undefined;
  /** Sets it; `anchor` is the toggle that was pressed (the transcript keeps it where it is on screen). */
  toggle(key: string, open: boolean, anchor: HTMLElement): void;
}

/** "mcp__github__search_issues" reads as "github · search_issues". */
export const toolLabel = (name: string): string => (name.startsWith("mcp__") ? name.slice(5).split("__").filter(Boolean).join(" · ") : name);

/** What a call line names: the target the reducer summarised, else the tool. A command shows its first line only. */
export function callTarget(item: ToolItem): string {
  const text = item.summary?.trim() || toolLabel(item.name);
  const nl = text.indexOf("\n");
  return nl < 0 ? text : `${text.slice(0, nl).trimEnd()} …`;
}

/** The full command of a shell call (the input, else the summary). */
const commandOf = (item: ToolItem): string | undefined => {
  if (item.toolKind !== "exec") return undefined;
  const input = item.input as { command?: unknown } | undefined;
  return (typeof input?.command === "string" ? input.command : item.summary)?.trim() || undefined;
};

/** "read 4 files, searched twice, ran 3 commands" with a capital first letter; thinking time last. */
export function groupSummary(group: ToolGroup): string {
  const parts = VERB_ORDER.flatMap((v) => group.tally.verbs.filter((x) => x.verb === v)).map(({ verb, n }) => t(`activity.verb.${verb}` as MessageKey, { n }));
  if (group.tally.thoughtSec > 0) parts.push(t("activity.verb.thought", { n: group.tally.thoughtSec }));
  const text = parts.join(", ");
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

/** The words of the group's state on its row: "Waiting for you", "1 failed · 1 blocked"; nothing when all went well. */
export function groupFlag(group: ToolGroup): string | undefined {
  if (group.state === "waiting") return t("activity.state.waiting");
  const words = [group.tally.failed ? t("activity.state.failed", { n: group.tally.failed }) : "", group.tally.blocked ? t("activity.state.blocked", { n: group.tally.blocked }) : ""].filter(Boolean);
  return words.length ? words.join(" · ") : undefined;
}

function Target(props: { item: ToolItem }) {
  const text = () => callTarget(props.item);
  return (
    <span class="act-call__target ui-mono" title={props.item.summary ?? props.item.name}>
      <Show when={PATH_KINDS.has(props.item.toolKind) && props.item.summary ? splitPath(text()) : undefined} fallback={<span class="act-call__base">{text()}</span>}>
        {(parts) => (
          <>
            <span class="act-call__dir">{parts()[0]}</span>
            <span class="act-call__base">{parts()[1]}</span>
          </>
        )}
      </Show>
    </span>
  );
}

function StatusMark(props: { item: ToolItem }) {
  return (
    <span class="act-call__status" data-status={props.item.status}>
      <Switch>
        <Match when={props.item.status === "running"}>
          <Spinner size={12} />
        </Match>
        <Match when={props.item.status === "error"}>
          <Icon icon={CircleAlert} size={14} />
        </Match>
        <Match when={props.item.status === "denied"}>
          <Icon icon={Ban} size={14} />
        </Match>
        <Match when={props.item.status === "cancelled"}>
          <Icon icon={X} size={14} />
        </Match>
      </Switch>
      <span class="ui-sr-only">{t(`chat.tool.${props.item.status}` as MessageKey)}</span>
    </span>
  );
}

/** One call of a group: icon, verb, target in mono, the size of an edit, the time and a mark when it did not simply work. */
export function ActivityCall(props: { item: ToolItem; state: OpenState }) {
  const command = () => commandOf(props.item);
  /** A command is shown in full when its line cannot hold it (several lines, or longer than a line usually is). */
  const longCommand = () => {
    const c = command();
    return !!c && (c.includes("\n") || c.length > 72);
  };
  const out = () => {
    const o = props.item.output;
    return o && o.length > OUTPUT_LIMIT ? `${o.slice(0, OUTPUT_LIMIT)}\n${t("chat.tool.moreChars", { n: o.length - OUTPUT_LIMIT })}` : o;
  };
  const expandable = () => !!(props.item.diff || props.item.output || longCommand());
  const failing = () => props.item.status === "error" || props.item.status === "denied";
  const open = () => expandable() && (props.state.isOpen(props.item.key) ?? failing());
  const delta = createMemo(() => {
    const d = props.item.diff;
    if (!d) return undefined;
    const lines = diffLines(d.old ?? "", d.new);
    return { added: lines.filter((l) => l.kind === "add").length, removed: lines.filter((l) => l.kind === "del").length };
  });
  const verb = () => t(`activity.${props.item.status === "running" ? "running" : "call"}.${props.item.toolKind}` as MessageKey);
  return (
    <div class="act-call" role="listitem" data-status={props.item.status} data-kind={props.item.toolKind}>
      <button type="button" class="act-call__head" aria-expanded={expandable() ? open() : undefined} disabled={!expandable()} onClick={(e) => props.state.toggle(props.item.key, !open(), e.currentTarget)}>
        <span class="act-call__icon" aria-hidden="true">
          <Icon icon={KIND_ICON[props.item.toolKind] ?? KIND_ICON.other} size={14} />
        </span>
        <span class="act-call__verb">{verb()}</span>{" "}
        <Target item={props.item} />{" "}
        <Show when={delta()}>
          {(d) => (
            <span class="act-call__delta ui-tnum" role="img" aria-label={t("chat.tool.delta", { added: d().added, removed: d().removed })}>
              <span class="act-call__add" aria-hidden="true">+{d().added}</span>
              <span class="act-call__del" aria-hidden="true">−{d().removed}</span>
            </span>
          )}
        </Show>
        <Show when={props.item.durationMs !== undefined && props.item.status !== "running"}>
          <span class="act-call__time ui-tnum">{fmtDuration(props.item.durationMs!)} </span>
        </Show>
        <StatusMark item={props.item} />
        <span class="act-call__chev" data-open={open() ? "" : undefined} data-hidden={expandable() ? undefined : ""} aria-hidden="true">
          <Icon icon={ChevronRight} size={12} />
        </span>
      </button>
      <Show when={open()}>
        <div class="act-call__body">
          <Show when={longCommand() ? command() : undefined}>
            {(c) => (
              <div class="act-block" role="group" aria-label={t("activity.command")}>
                <pre class="act-block__pre act-block__pre--cmd ui-selectable">{c()}</pre>
                <CopyButton text={c} label={t("activity.copyCommand")} />
              </div>
            )}
          </Show>
          <Show when={props.item.diff}>{(d) => <DiffPreview path={d().path} old={d().old ?? ""} new={d().new} />}</Show>
          <Show when={out()}>
            {(o) => (
              <div class="act-block" role="group" aria-label={t("activity.output")}>
                <pre class="act-block__pre ui-selectable" data-error={props.item.status === "error" ? "" : undefined}>
                  {o()}
                </pre>
              </div>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
}

/**
 * The row of a group. `member` draws a member that is not a call (a settled request: the transcript's own resolved card).
 * `live`: the run is at work and this is the newest row, so a running group shows its newest step.
 */
export function ActivityGroup(props: { group: ToolGroup; state: OpenState; live: boolean; member: (row: TranscriptRow) => JSX.Element }) {
  const open = () => props.state.isOpen(props.group.key) ?? (props.group.state === "failed" || props.group.state === "waiting");
  const running = () => props.group.state === "running" && props.live;
  const flag = () => groupFlag(props.group);
  const latestTool = () => {
    const members = props.group.members;
    for (let i = members.length - 1; i >= 0; i--) {
      const item = members[i]!.item;
      if (item.type === "tool") return item;
    }
    return undefined;
  };
  const [all, setAll] = createSignal(false);
  // The newest lines, and every failing one, until the person asks for the rest (a run of 500 calls stays light when opened).
  const shown = createMemo(() => {
    const members = props.group.members;
    if (all() || members.length <= GROUP_PAGE) return members;
    const failing = new Set(failingKeys(props.group));
    const from = members.length - GROUP_PAGE;
    return members.filter((m, i) => i >= from || failing.has(m.key));
  });
  const hidden = () => props.group.members.length - shown().length;
  return (
    <div class="act" data-state={props.group.state} data-live={running() ? "" : undefined} data-open={open() ? "" : undefined}>
      <button type="button" class="act__head" aria-expanded={open()} onClick={(e) => props.state.toggle(props.group.key, !open(), e.currentTarget)}>
        <span class="act__chev" data-open={open() ? "" : undefined} aria-hidden="true">
          <Icon icon={ChevronRight} size={12} />
        </span>
        <span class="ui-sr-only">{t("activity.group.sr")}: </span>
        <Show
          when={running() && latestTool()}
          fallback={<span class="act__summary">{groupSummary(props.group)}</span>}
        >
          {(tool) => (
            <span class="act__live" aria-live="off">
              <Spinner size={12} />
              <span class="act__live-verb">{t(`activity.running.${tool().toolKind}` as MessageKey)}</span>{" "}
              <span class="act__live-target ui-mono">{callTarget(tool())}</span>
            </span>
          )}
        </Show>
        <Show when={running()}>
          <span class="act__count ui-tnum">
            <span class="ui-sr-only">, </span>
            {t("chat.tool.calls", { n: props.group.tally.calls })}
          </span>
        </Show>
        <Show when={flag()}>
          {(f) => (
            <span class="act__flag" data-tone={props.group.state === "waiting" ? "warn" : "danger"}>
              <span class="act__dot" aria-hidden="true" />
              <span class="ui-sr-only">. </span>
              {f()}
            </span>
          )}
        </Show>
      </button>
      <Show when={open()}>
        <div class="act__list" role="list">
          <Show when={hidden() > 0}>
            <button type="button" class="act__more" onClick={() => setAll(true)}>
              {t("activity.more", { n: hidden() })}
            </button>
          </Show>
          <For each={shown()}>
            {(row) => (
              <Switch fallback={<div role="listitem" class="act__member">{props.member(row)}</div>}>
                <Match when={row.item.type === "tool" ? (row.item as ToolItem) : undefined}>{(item) => <ActivityCall item={item()} state={props.state} />}</Match>
                <Match when={row.item.type === "thinking" ? row.item : undefined}>
                  {(th) => (
                    <div role="listitem" class="act__member">
                      <ThinkingBlock item={th()} />
                    </div>
                  )}
                </Match>
              </Switch>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

