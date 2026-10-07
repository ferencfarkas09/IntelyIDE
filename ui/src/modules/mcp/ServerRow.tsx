import { createUniqueId, Show } from "solid-js";
import { fmt, t } from "../../i18n";
import type { McpPolicyPatch, McpServerView, McpWorkspaceState } from "../../ipc/mcp";
import { Badge, Button, ChevronDown, ChevronUp, Ellipsis, Globe, IconButton, Menu, MiddleEllipsis, Pencil, Play, SegmentedControl, SquareTerminal, StatusDot, Switch, Tooltip, Trash2, TriangleAlert } from "../../ui-kit";
import { changedSinceConfirm, POLICY_KEY, STATE_KEY, stateTone } from "./logic";
import { TestPanel, type TestState } from "./TestPanel";
import { ToolPolicyTable } from "./ToolPolicyTable";

export interface ServerRowProps {
  server: McpServerView;
  /** Read-only jail or a newer schema: nothing starts and nothing changes. */
  readOnly: boolean;
  /** Why Test is unavailable right now (the jail's sentence); shown as a tooltip. */
  testBlockedReason?: string;
  expanded: boolean;
  onToggleExpanded: () => void;
  test: TestState | undefined;
  /** The workspace of the open window; none while no workspace is open. */
  workspace: { id: string; name: string; state: McpWorkspaceState } | null;
  onTest: (timeoutMs?: number) => void;
  onEdit: () => void;
  onRemove: () => void;
  onEnable: (next: boolean) => void;
  onPatch: (patch: McpPolicyPatch) => Promise<void> | void;
  onWorkspace: (state: McpWorkspaceState) => void;
}

/** The part of a row's meta line that exists only after a Test. */
function metaParts(s: McpServerView): string[] {
  const parts: string[] = [];
  if (s.toolsTestedAt === null) {
    parts.push(t("mcp.row.notTested"));
  } else {
    parts.push(t("mcp.row.tools", { count: s.tools.length }));
    const readOnly = s.tools.filter((x) => x.readOnly).length;
    if (readOnly > 0) parts.push(t("mcp.row.readOnly", { count: readOnly }));
  }
  parts.push(t("mcp.row.defaultPolicy", { policy: t(POLICY_KEY[s.defaultPolicy]) }));
  if (s.toolsTestedAt !== null) parts.push(t("mcp.row.tested", { when: fmt.relative(s.toolsTestedAt) }));
  return parts;
}

/** One server ((design notes: mcp-management-spec) 7.2): state, what it runs, the On-by-default switch, Test and a menu; expands to its Test result, rules and workspace override. */
export function ServerRow(props: ServerRowProps) {
  const detailId = createUniqueId();
  const s = () => props.server;
  const display = () => (s().transport === "stdio" ? (s().commandLine ?? "") : (s().urlHost ?? s().url ?? ""));
  const testBlocked = () => props.readOnly || !!props.testBlockedReason;
  const running = () => props.test?.status === "running";

  return (
    <li class="mcp-row" data-state={s().state} data-expanded={props.expanded ? "" : undefined} aria-label={s().name}>
      <div class="mcp-row__main">
        <StatusDot tone={stateTone(s())} label={t(STATE_KEY[s().state])} />
        <div class="mcp-row__body">
          <div class="mcp-row__title">
            <code class="mcp-name">{s().name}</code>
            <Badge size="sm" icon={s().transport === "stdio" ? SquareTerminal : Globe}>{s().transport === "stdio" ? t("mcp.row.stdio") : t("mcp.row.http")}</Badge>
            <Badge size="sm" tone={s().state === "ready" ? "ok" : s().state === "invalid" || s().state === "unsupported" ? "danger" : "warn"}>{t(STATE_KEY[s().state])}</Badge>
            <Show when={s().fetchesCode}>
              <Badge size="sm" tone="warn" icon={TriangleAlert}>{t("mcp.row.fetchesCode")}</Badge>
            </Show>
          </div>
          <Show when={display()}>
            <div class="mcp-row__line" title={s().commandLine ?? s().url}><MiddleEllipsis text={display()} /></div>
          </Show>
          <div class="mcp-row__meta">{metaParts(s()).join(" · ")}</div>
        </div>
        <div class="mcp-row__actions">
          <Switch size="sm" checked={s().enabled} disabled={props.readOnly} label={t("mcp.field.enabled")} aria-label={t("mcp.row.enabled", { name: s().name })} onChange={props.onEnable} />
          <Tooltip label={props.testBlockedReason ?? ""} disabled={!props.testBlockedReason}>
            <Button size="sm" variant="secondary" icon={Play} loading={running()} aria-disabled={testBlocked() ? "true" : undefined} aria-label={t("mcp.row.testOf", { name: s().name })} onClick={() => !testBlocked() && props.onTest()}>
              {t("mcp.action.test")}
            </Button>
          </Tooltip>
          <Menu
            aria-label={t("mcp.row.menu", { name: s().name })}
            placement="bottom-end"
            items={[
              { label: t("mcp.action.edit"), icon: Pencil, disabled: props.readOnly, onSelect: props.onEdit },
              { label: t("mcp.action.test"), icon: Play, disabled: testBlocked() || running(), onSelect: () => props.onTest() },
              { type: "separator" },
              { label: t("mcp.action.remove"), icon: Trash2, danger: true, disabled: props.readOnly, onSelect: props.onRemove },
            ]}
            trigger={(tr) => <IconButton {...tr} icon={Ellipsis} size="sm" label={t("mcp.row.menu", { name: s().name })} />}
          />
        </div>
      </div>

      <Show when={changedSinceConfirm(s())}>
        <div class="mcp-note mcp-note--small" data-tone="warn"><TriangleAlert size={12} aria-hidden="true" /><span>{t("mcp.row.changed")}</span></div>
      </Show>

      <div class="mcp-row__foot">
        <Button size="sm" variant="ghost" iconRight={props.expanded ? ChevronUp : ChevronDown} aria-expanded={props.expanded} aria-controls={props.expanded ? detailId : undefined} aria-label={t("mcp.row.toolsOf", { name: s().name })} onClick={props.onToggleExpanded}>
          {t("mcp.action.tools")}
        </Button>
      </div>

      <Show when={props.expanded}>
        <div class="mcp-row__detail" id={detailId}>
          <Show when={props.test}>
            {(state) => <TestPanel name={s().name} state={state()} onRetryLong={() => props.onTest(30000)} />}
          </Show>
          <ToolPolicyTable server={s()} disabled={props.readOnly} onPatch={props.onPatch} onTest={() => props.onTest()} />
          <Show when={props.workspace}>
            {(ws) => (
              <div class="mcp-row__workspace">
                <span class="mcp-row__workspace-label">{t("mcp.workspace.label", { workspace: ws().name })}</span>
                <SegmentedControl<McpWorkspaceState>
                  size="sm"
                  aria-label={t("mcp.workspace.label", { workspace: ws().name })}
                  value={ws().state}
                  onChange={props.onWorkspace}
                  options={[
                    { value: "inherit", label: t("mcp.workspace.inherit") },
                    { value: "on", label: t("mcp.workspace.on") },
                    { value: "off", label: t("mcp.workspace.off") },
                  ]}
                />
                <p class="mcp-row__workspace-hint">{t("mcp.workspace.hint")}</p>
              </div>
            )}
          </Show>
        </div>
      </Show>
    </li>
  );
}
