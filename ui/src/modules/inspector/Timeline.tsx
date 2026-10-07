import { createMemo, createSignal, For, Show } from "solid-js";
import { fmtDuration, modelLabel } from "../../components/chat/format";
import { t, type MessageKey } from "../../i18n";
import type { ToolKind, ToolStatus } from "../../store/agent-types";
import { Badge, Ban, Brain, ChevronDown, ChevronRight, CircleCheck, CircleX, EmptyState, FileText, Globe, Icon, Layers, Minus, Pencil, Search, Spinner, SquareTerminal, Trash2, Wrench, ArrowRight, type LucideIcon } from "../../ui-kit";
import { timelineSpan, visibleTools, type Inspection, type ToolNode } from "./model";

const KIND_ICON: Record<ToolKind, LucideIcon> = { read: FileText, edit: Pencil, delete: Trash2, move: ArrowRight, search: Search, exec: SquareTerminal, fetch: Globe, think: Brain, mcp: Layers, other: Wrench };
const STATUS_KEY = { running: "inspector.tl.running", ok: "inspector.tl.ok", error: "inspector.tl.error", denied: "inspector.tl.denied", cancelled: "inspector.tl.cancelled" } as const satisfies Record<ToolStatus, MessageKey>;
const statusText = (s: ToolStatus): string => t(STATUS_KEY[s]);

function StatusIcon(props: { status: ToolStatus }) {
  return (
    <span class="insp-status" data-status={props.status} role="img" aria-label={statusText(props.status)} title={statusText(props.status)}>
      {props.status === "running" ? <Spinner size={12} label={t("inspector.tl.running")} /> : <Icon icon={props.status === "ok" ? CircleCheck : props.status === "error" ? CircleX : props.status === "denied" ? Ban : Minus} size={14} />}
    </span>
  );
}

const BY: Record<string, MessageKey> = { hardStop: "inspector.by.hardStop", roleDeny: "inspector.by.roleDeny", user: "inspector.by.user", saved: "inspector.by.saved", failClosed: "inspector.by.failClosed", default: "inspector.by.default", unknown: "inspector.by.unknown" };
const byText = (by: string): string => (by in BY ? t(BY[by]) : by);

export function Timeline(props: { inspection: Inspection }) {
  const roleColorOf = (name: string) => props.inspection.delegates.find((d) => d.name === name)?.color ?? undefined;
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  const [open, setOpen] = createSignal<string | null>(null);
  const rows = createMemo(() => visibleTools(props.inspection, collapsed()));
  const span = createMemo(() => timelineSpan(props.inspection));
  const toggle = (id: string) => setCollapsed((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  const bar = (n: ToolNode) => {
    const { start, length } = span();
    const left = ((n.startedMs - start) / length) * 100;
    const width = Math.max(((n.durationMs ?? 0) / length) * 100, 0.8);
    return { left: `${Math.min(left, 99.2)}%`, width: `${Math.min(width, 100 - Math.min(left, 99.2))}%` };
  };

  return (
    <Show when={rows().length > 0} fallback={<EmptyState icon={Wrench} size="sm" title={t("inspector.tl.none")} description={t("inspector.tl.noneDesc")} />}>
      <ol class="insp-timeline" aria-label={t("inspector.tl.label")}>
        <For each={rows()}>
          {(n) => (
            <li class="insp-tool" data-kind={n.toolKind} data-status={n.status} style={{ "--depth": n.depth }}>
              <div class="insp-tool__row">
                <span class="insp-tool__twist">
                  <Show when={n.children.length > 0}>
                    <button type="button" class="insp-twist" aria-expanded={!collapsed().has(n.toolId)} aria-label={t(collapsed().has(n.toolId) ? "inspector.tl.expand" : "inspector.tl.collapse", { name: n.name, n: n.children.length })} onClick={() => toggle(n.toolId)}>
                      <Icon icon={collapsed().has(n.toolId) ? ChevronRight : ChevronDown} size={14} />
                    </button>
                  </Show>
                </span>
                <button type="button" class="insp-tool__main" aria-expanded={open() === n.toolId} onClick={() => setOpen(open() === n.toolId ? null : n.toolId)}>
                  <Icon icon={KIND_ICON[n.toolKind]} size={14} class="insp-tool__icon" />
                  <span class="insp-tool__name">{n.name}</span>
                  <Show when={n.children.length > 0}>
                    <span class="insp-tool__sub ui-tnum">{t("inspector.tl.nested", { n: n.children.length })}</span>
                  </Show>
                  <Show when={n.role}>
                    {(role) => (
                      <span class="insp-rolechip" title={n.model ? `${role()} · ${n.model}` : role()}>
                        <span class="insp-role__swatch" style={{ background: roleColorOf(role()) ?? "var(--text-4)" }} aria-hidden="true" />
                        {role()}
                        <Show when={n.model}>{(m) => <Badge size="sm">{modelLabel(m())}</Badge>}</Show>
                      </span>
                    )}
                  </Show>
                  <span class="insp-tool__summary ui-truncate" title={n.summary}>
                    {n.summary}
                  </span>
                </button>
                <span class="insp-tool__bar" aria-hidden="true">
                  <span class="insp-tool__fill" style={bar(n)} />
                </span>
                <span class="insp-tool__time ui-tnum">{n.durationMs === undefined ? "…" : fmtDuration(n.durationMs)}</span>
                <StatusIcon status={n.status} />
              </div>
              <Show when={n.refused}>
                {(r) => (
                  <p class="insp-tool__refused" role="note">
                    {t("inspector.denied.by", { by: byText(r().by), role: r().role ?? n.role ?? "?", rule: r().rule ?? "–" })}
                  </p>
                )}
              </Show>
              <Show when={open() === n.toolId}>
                <pre class="insp-tool__out" tabindex="0">{n.output?.trim() ? n.output : t("inspector.tl.noOutput")}</pre>
              </Show>
            </li>
          )}
        </For>
      </ol>
    </Show>
  );
}
