import { createMemo, createSignal, For, Show } from "solid-js";
import { t } from "../../i18n";
import type { McpPolicy, McpPolicyPatch, McpServerView, McpToolView } from "../../ipc/mcp";
import { Badge, Button, Check, CircleQuestionMark, Dialog, Input, Pencil, Search, SegmentedControl, Select, ShieldAlert, Tooltip, TriangleAlert } from "../../ui-kit";
import {
  allowReadOnlyPatch,
  filterTools,
  loosensBlocked,
  orderTools,
  POLICIES,
  POLICY_KEY,
  RESOURCES_TOOL,
  resetRulesPatch,
  resourcesRule,
  staleRules,
  toolMark,
  type RuleChoice,
  type ToolMark,
} from "./logic";

export interface ToolPolicyTableProps {
  server: McpServerView;
  disabled?: boolean;
  /** One `mcp_set_policy` call (optimistic in the caller); it rejects with the command's error, which the caller shows. */
  onPatch: (patch: McpPolicyPatch) => Promise<void> | void;
  onTest: () => void;
}

const MARK: Record<ToolMark, { tone: "ok" | "warn" | "neutral"; icon: typeof Check; text: () => string }> = {
  reads: { tone: "ok", icon: Check, text: () => t("mcp.tools.readOnly") },
  writes: { tone: "warn", icon: Pencil, text: () => t("mcp.tools.writes") },
  unknown: { tone: "neutral", icon: CircleQuestionMark, text: () => t("mcp.tools.unknown") },
};

interface Pending {
  tool: string;
  choice: RuleChoice;
}

/**
 * The rules of one server ((design notes: mcp-management-spec) 7.6): a default for tools without their own rule, then one row per tool the last
 * Test learned, each with what the server SAYS about it (an untrusted claim, worded that way) and a rule. A tool that looks like it commits,
 * pushes or deploys is blocked by default; loosening it asks first, and only then is `acknowledgeBlocked` sent.
 */
export function ToolPolicyTable(props: ToolPolicyTableProps) {
  const [query, setQuery] = createSignal("");
  const [pending, setPending] = createSignal<Pending | null>(null);
  // A native select shows what the user picked even when the choice is not applied (the warning dialog was cancelled): a new key builds it again from the rule.
  const [sync, setSync] = createSignal(1);
  const cancelPending = () => (setPending(null), setSync((n) => n + 1));
  const tested = () => props.server.toolsTestedAt !== null;
  const visible = createMemo(() => orderTools(filterTools(props.server.tools, query())));
  const readOnlyPatch = () => allowReadOnlyPatch(props.server);
  const resetPatch = () => resetRulesPatch(props.server);
  const pendingTool = () => props.server.tools.find((x) => x.key === pending()?.tool);
  const inheritLabel = () => t("mcp.tools.inherit", { policy: t(POLICY_KEY[props.server.defaultPolicy]) });
  const options = () => [
    { value: "inherit" as const, label: inheritLabel() },
    ...POLICIES.map((p) => ({ value: p, label: t(POLICY_KEY[p]) })),
  ];

  const send = (tool: string, choice: RuleChoice, acknowledgeBlocked?: boolean) =>
    props.onPatch({ tools: [{ tool, policy: choice === "inherit" ? null : choice, ...(acknowledgeBlocked ? { acknowledgeBlocked: true } : {}) }] });

  function choose(tool: McpToolView, choice: RuleChoice) {
    if (loosensBlocked(tool, choice, props.server.defaultPolicy)) setPending({ tool: tool.key, choice });
    else void send(tool.key, choice);
  }

  async function confirmUnblock() {
    const p = pending();
    setPending(null);
    if (p) await send(p.tool, p.choice, true);
  }

  const ruleSelect = (tool: string, label: string, value: () => RuleChoice, onChange: (c: RuleChoice) => void) => (
    <Show when={sync()} keyed>
      {(_generation) => <Select<RuleChoice> size="sm" aria-label={t("mcp.tools.ruleFor", { tool: label })} disabled={props.disabled} options={options()} value={value()} onChange={onChange} data-tool={tool} />}
    </Show>
  );

  return (
    <section class="mcp-tools" aria-label={t("mcp.tools.title")}>
      <div class="mcp-tools__default">
        <span class="mcp-tools__default-label">{t("mcp.tools.default")}</span>
        <SegmentedControl<McpPolicy>
          size="sm"
          aria-label={t("mcp.tools.default")}
          value={props.server.defaultPolicy}
          onChange={(p) => !props.disabled && void props.onPatch({ defaultPolicy: p })}
          options={POLICIES.map((p) => ({ value: p, label: t(POLICY_KEY[p]), disabled: props.disabled }))}
        />
      </div>

      <Show when={props.server.toolsStale}>
        <div class="mcp-note" data-tone="warn" role="status"><TriangleAlert size={14} aria-hidden="true" /><span>{t("mcp.tools.stale")}</span></div>
      </Show>

      <Show
        when={tested()}
        fallback={
          <div class="mcp-tools__never">
            <p>{t("mcp.tools.never")}</p>
            <Button size="sm" variant="secondary" disabled={props.disabled} onClick={props.onTest}>{t("mcp.action.test")}</Button>
          </div>
        }
      >
        <div class="mcp-tools__bar">
          <Input
            size="sm"
            wrapperClass="mcp-tools__filter"
            aria-label={t("mcp.tools.filter")}
            placeholder={t("mcp.tools.filter")}
            autocomplete="off"
            spellcheck={false}
            leading={<Search size={14} aria-hidden="true" />}
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <Button size="sm" variant="secondary" disabled={props.disabled || !readOnlyPatch()} onClick={() => void props.onPatch(readOnlyPatch()!)}>{t("mcp.tools.allowReadOnly")}</Button>
          <Button size="sm" variant="ghost" disabled={props.disabled || !resetPatch()} onClick={() => void props.onPatch(resetPatch()!)}>{t("mcp.tools.reset")}</Button>
        </div>

        <div class="mcp-tools__scroll">
          <table class="mcp-table" aria-label={t("mcp.tools.title")}>
            <thead>
              <tr>
                <th scope="col">{t("mcp.tools.colTool")}</th>
                <th scope="col">{t("mcp.tools.colHint")}</th>
                <th scope="col">{t("mcp.tools.colRule")}</th>
              </tr>
            </thead>
            <tbody>
              <For each={visible()} fallback={props.server.tools.length > 0 ? <tr><td colSpan={3} class="mcp-table__none">{t("mcp.tools.empty")}</td></tr> : null}>
                {(tool) => {
                  const mark = () => MARK[toolMark(tool)];
                  return (
                    <tr data-tool={tool.key}>
                      <td class="mcp-table__tool">
                        <div class="mcp-table__name">
                          <Tooltip label={tool.description || tool.name}>
                            <code class="mcp-mono">{tool.name}</code>
                          </Tooltip>
                          <Show when={tool.blockedByDefault}>
                            <Badge tone="warn" size="sm" icon={ShieldAlert} title={t("mcp.tools.blocked")}>{t("mcp.tools.blockedShort")}</Badge>
                          </Show>
                        </div>
                        <Show when={tool.description}>
                          <span class="mcp-table__desc" title={tool.description}>{tool.description}</span>
                        </Show>
                      </td>
                      <td><Badge tone={mark().tone} size="sm" icon={mark().icon}>{mark().text()}</Badge></td>
                      <td>{ruleSelect(tool.key, tool.name, () => tool.policy ?? "inherit", (c) => choose(tool, c))}</td>
                    </tr>
                  );
                }}
              </For>
              <tr data-tool={RESOURCES_TOOL} class="mcp-table__resources">
                <td class="mcp-table__tool"><span class="mcp-table__name">{t("mcp.tools.resources")}</span></td>
                <td><Badge tone="neutral" size="sm" icon={CircleQuestionMark}>{t("mcp.tools.unknown")}</Badge></td>
                <td>{ruleSelect(RESOURCES_TOOL, t("mcp.tools.resources"), () => resourcesRule(props.server) ?? "inherit", (c) => void send(RESOURCES_TOOL, c))}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <Show when={staleRules(props.server).length > 0}>
          <div class="mcp-tools__stale">
            <span>{t("mcp.tools.staleRules", { names: staleRules(props.server).map((r) => r.tool).join(", ") })}</span>
            <For each={staleRules(props.server)}>
              {(rule) => (
                <Button size="sm" variant="ghost" aria-label={t("mcp.tools.removeRule", { tool: rule.tool })} disabled={props.disabled} onClick={() => void send(rule.tool, "inherit")}>
                  {t("mcp.action.remove")}
                </Button>
              )}
            </For>
          </div>
        </Show>
      </Show>

      <details class="mcp-details mcp-tools__modes">
        <summary>{t("mcp.tools.modesTitle")}</summary>
        <ul>
          <li>{t("mcp.tools.modePlan")}</li>
          <li>{t("mcp.tools.modeAsk")}</li>
          <li>{t("mcp.tools.modeAuto")}</li>
          <li>{t("mcp.tools.modeAutoUnlisted")}</li>
        </ul>
      </details>
      <p class="mcp-tools__live">{t("mcp.tools.liveHint")}</p>

      <Dialog
        open={!!pending()}
        onClose={cancelPending}
        role="alertdialog"
        size="sm"
        title={t("mcp.tools.unblock.title", { tool: pendingTool()?.name ?? pending()?.tool ?? "" })}
        description={t("mcp.tools.unblock.body")}
        footer={
          <>
            <Button variant="secondary" data-autofocus onClick={cancelPending}>{t("mcp.cancel")}</Button>
            <Button variant="primary" onClick={() => void confirmUnblock()}>{t("mcp.tools.unblock.ok")}</Button>
          </>
        }
      />
    </section>
  );
}
