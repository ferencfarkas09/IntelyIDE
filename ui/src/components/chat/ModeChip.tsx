import { createEffect, createSignal, on, Show } from "solid-js";
import { t } from "../../i18n";
import { setRunMode, type AgentRow } from "../../store/agents";
import type { PermissionMode } from "../../store/agent-types";
import { chipRequest } from "../../store/chatCommands";
import { Badge, ChevronDown, Icon, Menu, Pill, Spinner, toast, type MenuEntry } from "../../ui-kit";
import { BypassConfirmDialog } from "./BypassConfirmDialog";
import { effectiveMode, exposureOf, MODE_META, MODE_ORDER, modeErrorText, strictness } from "./modes";
import "./modes.css";

/**
 * The mode of a run in its header. For a provider that can switch live (Claude and the mock) it is a menu: the five modes with their
 * one-line explanations, a Bypass pick behind its confirm dialog. Elsewhere it is the plain badge it always was. In Bypass a red
 * BYPASS chip stands next to it for as long as the run is in that mode.
 */
export function ModeChip(props: { agent: AgentRow }) {
  const a = () => props.agent;
  const mode = () => effectiveMode(a());
  const label = (m: PermissionMode) => t(MODE_META[m].label);
  const switchable = () => MODE_ORDER.filter((m) => a().switchableModes?.includes(m));
  const [busy, setBusy] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  // The composer's `/mode` opens this run's menu.
  createEffect(
    on(chipRequest, (r) => {
      if (r && r.target === "mode" && r.agentId === a().agentId && switchable().length > 0) setMenuOpen(true);
    }, { defer: true }),
  );

  /** What picking a mode tells a person at the moment of choosing: its explanation, and for the unattended pair what MCP tools then run unasked. */
  const description = (m: PermissionMode): string => {
    const lines: string[] = [t(MODE_META[m].hint)];
    if (m === "automatic" || m === "bypass") {
      const x = exposureOf(a().mcp);
      if (x.count > 0) lines.push(t("modes.exposure.line", { count: x.count, names: x.names }));
      if (x.secretNames) lines.push(t("modes.exposure.secretEnv", { names: x.secretNames }));
    }
    return lines.join(" ");
  };

  const apply = async (m: PermissionMode, confirmed: boolean) => {
    const before = mode();
    setBusy(true);
    try {
      await setRunMode(a().agentId, m, confirmed ? { confirmBypass: true } : undefined);
      toast.success(t("modes.switch.done", { mode: label(m) }), strictness(m) < strictness(before) ? t("modes.switch.runningNote") : undefined);
    } catch (e) {
      const err = e as { code?: string; message?: string } | null;
      // The host kept the stricter mode for itself when the agent could not follow a tightening: the run is as safe as asked.
      if (err?.code === "modeNotApplied" && strictness(m) < strictness(before)) toast.warn(t("modes.switch.partial", { mode: label(m) }));
      else toast.error(t("modes.switch.failed"), modeErrorText(err?.code, err?.message));
    } finally {
      setBusy(false);
    }
  };
  const choose = (m: PermissionMode) => {
    if (m === mode() || busy()) return;
    if (m === "bypass") setConfirming(true);
    else void apply(m, false);
  };

  const items = (): MenuEntry[] => [
    { type: "label", label: t("modes.header.menu") },
    ...switchable().map(
      (m): MenuEntry => ({ label: label(m), description: description(m), icon: MODE_META[m].icon, checked: m === mode(), radio: true, danger: m === "bypass", onSelect: () => choose(m) }),
    ),
  ];

  return (
    <span class="mode-chip">
      <Show when={mode() === "bypass"}>
        <span role="status" title={t("modes.header.bypassTip")}>
          <Badge tone="danger" variant="solid" icon={MODE_META.bypass.icon}>
            {t("modes.header.bypassChip")}
          </Badge>
        </span>
      </Show>
      <Show
        when={switchable().length > 0}
        fallback={<Badge title={t("chat.header.permissionMode", { mode: label(mode()) })}>{t("chat.header.mode", { mode: label(mode()) })}</Badge>}
      >
        <Menu
          aria-label={t("modes.header.menu")}
          class="mode-menu"
          open={menuOpen()}
          onOpenChange={setMenuOpen}
          items={items()}
          trigger={(tp) => (
            <Pill
              class="mode-chip__pill"
              size="sm"
              tone={MODE_META[mode()].tone === "danger" ? "danger" : mode() === "readOnly" || mode() === "ask" ? "neutral" : "accent"}
              leading={<Icon icon={MODE_META[mode()].icon} size={12} />}
              trailing={busy() ? <Spinner size={12} /> : <Icon icon={ChevronDown} size={12} class="mode-chip__chev" />}
              onClick={tp.onClick}
              title={t("chat.header.permissionMode", { mode: label(mode()) })}
              aria-label={t("modes.header.change", { mode: label(mode()) })}
              buttonProps={{ ref: tp.ref, onKeyDown: tp.onKeyDown, "aria-haspopup": tp["aria-haspopup"], "aria-expanded": tp["aria-expanded"], "aria-controls": tp["aria-controls"], "aria-busy": busy() ? "true" : undefined }}
            >
              {label(mode())}
            </Pill>
          )}
        />
      </Show>
      <BypassConfirmDialog
        open={confirming()}
        context="switch"
        mcp={a().mcp}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void apply("bypass", true);
        }}
      />
    </span>
  );
}
