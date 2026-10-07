import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { t, type MessageKey } from "../../i18n";
import { ipc } from "../../ipc";
import { openSettings } from "../../platform/settings";
import type { AgentRow } from "../../store/agents";
import type { McpServerState, McpServerStatus } from "../../store/agent-types";
import { chipRequest } from "../../store/chatCommands";
import { Button, Icon, Plug, Pill, Popover, RefreshCw, Spinner, StatusDot, type Tone } from "../../ui-kit";
import "./mcp-chip.css";

const STATE_TEXT = {
  connected: "slash.mcp.state.connected",
  failed: "slash.mcp.state.failed",
  pending: "slash.mcp.state.pending",
  needsAuth: "slash.mcp.state.needsAuth",
  disabled: "slash.mcp.state.disabled",
} as const satisfies Record<McpServerState, MessageKey>;

const STATE_TONE = { connected: "ok", failed: "danger", pending: "warn", needsAuth: "warn", disabled: "neutral" } as const satisfies Record<McpServerState, Tone>;

/** One row as the popover shows it: the live status when it was read, else what the session reported at init. */
interface Row {
  name: string;
  status: McpServerState;
  error?: string | null;
  toolCount?: number;
  toolNames: string[];
}

export function mcpRows(init: AgentRow["mcpServers"], live: McpServerStatus[] | null): Row[] {
  if (live) return live.map((s) => ({ name: s.name, status: s.status, error: s.error, toolCount: (s.tools ?? []).length || undefined, toolNames: (s.tools ?? []).map((x) => x.name) }));
  return (init ?? []).map((s) => ({ name: s.name, status: s.status, error: s.error, toolCount: s.tools ?? undefined, toolNames: [] }));
}

/** The worst state of the set picks the chip colour: a failed server is red, one that waits or needs sign-in is amber. */
export function mcpTone(rows: Row[]): Tone {
  if (rows.some((r) => r.status === "failed")) return "danger";
  if (rows.some((r) => r.status === "pending" || r.status === "needsAuth")) return "warn";
  return "neutral";
}

/**
 * `MCP 2/3` in the run header: how many of the run's MCP servers are connected. Hidden when the run has none. The popover lists every server
 * with its state, tool count and error, reads the live status when it opens (and on Refresh) and links to Settings. The composer's `/mcp` opens it.
 */
export function McpChip(props: { agent: AgentRow }) {
  const a = () => props.agent;
  const [open, setOpen] = createSignal(false);
  const [live, setLive] = createSignal<McpServerStatus[] | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null); // "all" or a server name
  const [problem, setProblem] = createSignal<string | null>(null);
  let ticket = 0;
  onCleanup(() => void ticket++);

  const rows = createMemo(() => mcpRows(a().mcpServers, live()));
  const connected = () => rows().filter((r) => r.status === "connected").length;

  async function load(call: () => Promise<McpServerStatus[]>, who: string) {
    const mine = ++ticket;
    setBusy(who);
    setProblem(null);
    try {
      const next = await call();
      if (mine === ticket) setLive(next);
    } catch (e) {
      if (mine !== ticket) return;
      const err = e as { code?: string; message?: string } | null;
      setProblem(err?.code === "notRunning" ? t("slash.mcp.notRunning") : t("slash.mcp.failed", { detail: err?.message ?? "" }));
    } finally {
      if (mine === ticket) setBusy(null);
    }
  }
  const refresh = () => load(() => ipc.agentMcpStatus(a().agentId), "all");
  const reconnect = (server: string) => load(() => ipc.agentMcpReconnect(a().agentId, server), server);

  createEffect(on(open, (isOpen) => void (isOpen && refresh())));
  // The header keeps one chip while the person switches runs: the live status, the open popover and a pending call belong to ONE run.
  createEffect(
    on(() => a().agentId, () => {
      ticket++;
      setLive(null);
      setOpen(false);
      setBusy(null);
      setProblem(null);
    }, { defer: true }),
  );
  // The composer's `/mcp`: open this run's popover.
  createEffect(
    on(chipRequest, (r) => {
      if (r && r.target === "mcp" && r.agentId === a().agentId && rows().length > 0) setOpen(true);
    }, { defer: true }),
  );

  const manage = (close: () => void) => {
    close();
    openSettings("mcp");
  };

  return (
    <Show when={rows().length > 0}>
      <Popover
        open={open()}
        onOpenChange={setOpen}
        class="mcp-pop"
        aria-label={t("slash.mcp.title")}
        trigger={(tp) => (
          <Pill
            class="mcp-chip"
            size="sm"
            tone={mcpTone(rows())}
            leading={<Icon icon={Plug} size={12} />}
            onClick={tp.onClick}
            title={t("slash.mcp.chipTip", { connected: connected(), total: rows().length })}
            aria-label={t("slash.mcp.chipAria", { connected: connected(), total: rows().length })}
            buttonProps={{ ref: tp.ref, onKeyDown: tp.onKeyDown, "aria-haspopup": tp["aria-haspopup"], "aria-expanded": tp["aria-expanded"], "aria-controls": tp["aria-controls"] }}
          >
            {t("slash.mcp.chip", { connected: connected(), total: rows().length })}
          </Pill>
        )}
      >
        {(api) => (
          <div class="mcp-pop__body" data-testid="mcp-popover">
            <div class="mcp-pop__head">
              <span class="mcp-pop__title">{t("slash.mcp.title")}</span>
              <Button size="sm" variant="ghost" icon={RefreshCw} loading={busy() === "all"} onClick={() => void refresh()} disabled={busy() !== null}>
                {busy() === "all" ? t("slash.mcp.refreshing") : t("slash.mcp.refresh")}
              </Button>
            </div>
            <Show when={problem()}>{(p) => <p class="mcp-pop__note" role="status">{p()}</p>}</Show>
            <ul class="mcp-pop__list">
              <For each={rows()}>
                {(r) => (
                  <li class="mcp-row" data-state={r.status}>
                    <div class="mcp-row__line">
                      <StatusDot tone={STATE_TONE[r.status]} label={t(STATE_TEXT[r.status])} />
                      <span class="mcp-row__name ui-truncate">{r.name}</span>
                      <span class="mcp-row__state">{t(STATE_TEXT[r.status])}</span>
                      <span class="mcp-row__grow" />
                      <Show when={r.toolCount !== undefined}>
                        <span class="mcp-row__tools ui-tnum" title={r.toolNames.join(", ") || undefined}>{t("slash.mcp.tools", { count: r.toolCount ?? 0 })}</span>
                      </Show>
                      <Show when={r.status === "failed"}>
                        <Button size="sm" variant="ghost" aria-label={t("slash.mcp.reconnectAria", { server: r.name })} loading={busy() === r.name} disabled={busy() !== null} onClick={() => void reconnect(r.name)}>
                          {t("slash.mcp.reconnect")}
                        </Button>
                      </Show>
                    </div>
                    <Show when={r.error}>{(e) => <p class="mcp-row__error">{e()}</p>}</Show>
                  </li>
                )}
              </For>
            </ul>
            <div class="mcp-pop__foot">
              <Show when={busy() !== null}>
                <Spinner size={12} />
              </Show>
              <span class="mcp-row__grow" />
              <Button size="sm" variant="ghost" onClick={() => manage(api.close)}>
                {t("slash.mcp.manage")}
              </Button>
            </div>
          </div>
        )}
      </Popover>
    </Show>
  );
}
