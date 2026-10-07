import type { PermissionMode } from "@intely/protocol";
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { McpRunServer } from "../../ipc/mcp";
import { openSettings } from "../../platform/settings";
import { Button, Check, Globe, Icon, ShieldAlert, SquareTerminal as Terminal, Tooltip, TriangleAlert } from "../../ui-kit";
import { fixableInSettings, mcpDefaultSelection, mcpProviderSupported, pickerWarnings, pruneSelection, UNAVAILABLE_KEY } from "./logic";
import "./mcp.css";

export { mcpProviderSupported, mcpStartIds } from "./logic";

export interface McpRunPickerProps {
  /** Selected server ids. Controlled by the parent. Start with []: the picker seeds the defaults itself (below). */
  value: string[];
  onChange: (ids: string[]) => void;
  /** Provider the run will use. Only "claude" (and "mock" when the mock provider is on) support MCP; for any other value the component renders NOTHING
   *  and the parent must send no servers (`mcpStartIds` returns []). */
  provider: string;
  /** The run's chosen mode (D9): drives the warning line for automatic/bypass and the hint for plan. */
  mode: PermissionMode;
  /** The active workspace id (`activeId()` from store/workspaces), or null: the defaults then ignore overrides. */
  workspaceId: string | null;
  disabled?: boolean;
}

/**
 * The servers a new run starts with ((design notes: mcp-management-spec) 7.7): a labelled group of toggle chips, preselected from the workspace
 * default. It never starts or tests anything and never shows a command line. Until the user touches a chip it seeds the defaults after
 * every load; after the first toggle it never reseeds, and it only drops ids that are no longer available. It renders nothing for a
 * provider without MCP, until the first load resolved, and when the load failed (logged once).
 */
export function McpRunPicker(props: McpRunPickerProps) {
  const [servers, setServers] = createSignal<McpRunServer[] | null>(null);
  const [touched, setTouched] = createSignal(false);
  let warned = false;
  let generation = 0;

  async function load() {
    const my = ++generation;
    if (!mcpProviderSupported(props.provider)) return;
    try {
      const list = await ipc.mcp.runServers(props.workspaceId, props.provider);
      if (my !== generation) return;
      setServers(list);
      if (touched()) {
        const kept = pruneSelection(props.value, list);
        if (kept.length !== props.value.length) props.onChange(kept);
      } else {
        const defaults = mcpDefaultSelection(list);
        if (defaults.length !== props.value.length || defaults.some((id, i) => id !== props.value[i])) props.onChange(defaults);
      }
    } catch (e) {
      if (my !== generation) return;
      setServers(null);
      if (!warned) {
        warned = true;
        console.warn("MCP servers of the run picker could not be loaded", e);
      }
    }
  }

  createEffect(on([() => props.workspaceId, () => props.provider], () => void load()));
  onCleanup(ipc.settings.onChange((e) => e.ns === "mcp" && void load()));

  const selected = createMemo(() => (servers() ?? []).filter((s) => props.value.includes(s.id)));
  const warnings = createMemo(() => pickerWarnings(props.mode, selected()));

  function toggle(s: McpRunServer) {
    if (props.disabled || !s.available) return;
    setTouched(true);
    props.onChange(props.value.includes(s.id) ? props.value.filter((id) => id !== s.id) : [...props.value, s.id]);
  }

  return (
    <Show when={mcpProviderSupported(props.provider) && servers()}>
      {(list) => (
        <fieldset class="mcp-picker" disabled={props.disabled}>
          <legend class="mcp-picker__label">{t("mcp.picker.title")}</legend>
          <Show
            when={list().length > 0}
            fallback={
              <p class="mcp-picker__none">
                {t("mcp.picker.none")}{" "}
                <Button size="sm" variant="ghost" onClick={() => openSettings("mcp")}>{t("mcp.picker.setup")}</Button>
              </p>
            }
          >
            <div class="mcp-picker__chips" role="group" aria-label={t("mcp.picker.aria")}>
              <For each={list()}>
                {(s) => {
                  const on = () => props.value.includes(s.id);
                  const reason = () => (s.unavailable ? t(UNAVAILABLE_KEY[s.unavailable]) : undefined);
                  /** One name for the chip: the server, what it offers or why it cannot start, and the warning mark. */
                  const label = () => [s.name, s.available ? t("mcp.row.tools", { count: s.toolCount }) : reason(), s.hasDenied ? t("mcp.picker.denied") : undefined].filter(Boolean).join(", ");
                  return (
                    <span class="mcp-picker__item">
                      <Tooltip label={reason() ?? t("mcp.row.tools", { count: s.toolCount })} disabled={!reason()}>
                        <button
                          type="button"
                          class="mcp-chip"
                          role="checkbox"
                          aria-label={label()}
                          aria-checked={on()}
                          aria-disabled={!s.available || props.disabled ? "true" : undefined}
                          data-on={on() ? "" : undefined}
                          onClick={() => toggle(s)}
                        >
                          <Show when={on()}><Icon icon={Check} size={12} /></Show>
                          <Icon icon={s.transport === "stdio" ? Terminal : Globe} size={12} />
                          <span class="mcp-mono mcp-chip__name">{s.name}</span>
                          <Show when={s.available}>
                            <span class="mcp-chip__count">{t("mcp.row.tools", { count: s.toolCount })}</span>
                          </Show>
                          <Show when={s.hasDenied}>
                            <span class="mcp-chip__denied" title={t("mcp.picker.denied")} role="img" aria-label={t("mcp.picker.denied")}><ShieldAlert size={12} /></span>
                          </Show>
                        </button>
                      </Tooltip>
                      <Show when={!s.available && fixableInSettings(s.unavailable)}>
                        <Button size="sm" variant="ghost" class="mcp-picker__open" aria-label={`${t("mcp.picker.openSettings")}: ${s.name}`} onClick={() => openSettings("mcp")}>{t("mcp.picker.openSettings")}</Button>
                      </Show>
                    </span>
                  );
                }}
              </For>
            </div>
            <Show when={warnings().mode || warnings().secretEnv.length > 0 || warnings().exposure}>
              <div class="mcp-picker__notes">
                <Show when={warnings().mode}>
                  {(mode) => (
                    <p class="mcp-note mcp-note--small" data-tone={mode() === "plan" ? "info" : "warn"}>
                      <TriangleAlert size={12} aria-hidden="true" />
                      <span>{t(mode() === "automatic" ? "mcp.picker.warnAutomatic" : mode() === "bypass" ? "mcp.picker.warnBypass" : "mcp.picker.hintPlan")}</span>
                    </p>
                  )}
                </Show>
                <Show when={warnings().secretEnv.length > 0}>
                  <p class="mcp-note mcp-note--small" data-tone="warn"><TriangleAlert size={12} aria-hidden="true" /><span>{t("mcp.picker.warnSecretEnv", { names: warnings().secretEnv.join(", ") })}</span></p>
                </Show>
                <Show when={warnings().exposure}>
                  {(x) => <p class="mcp-note mcp-note--small" data-tone="warn"><TriangleAlert size={12} aria-hidden="true" /><span>{t("mcp.picker.warnExposure", { count: x().count, names: x().names.join(", ") })}</span></p>}
                </Show>
              </div>
            </Show>
          </Show>
        </fieldset>
      )}
    </Show>
  );
}
