import { createMemo, Show } from "solid-js";
import { t } from "../../i18n";
import type { McpTestReport } from "../../ipc/mcp";
import { Button, CircleAlert, CircleCheck, LiveRegion, Spinner } from "../../ui-kit";
import { testErrorKey, type ErrorInfo } from "./logic";

/** What the panel under a row shows: a Test in flight, its report, or the rejection of the command itself (confirmation, jail, busy). */
export type TestState = { status: "running" } | { status: "done"; report: McpTestReport } | { status: "failed"; error: ErrorInfo };

export interface TestPanelProps {
  name: string;
  state: TestState;
  /** After `mcpTimeout`: the same Test with 30 s, because a first `npx` run may download a package. */
  onRetryLong?: () => void;
}

const list = (keys: readonly string[]) => keys.join(", ");
const seconds = (ms: number) => (ms / 1000).toFixed(1);

/** The failure of a Test in words: the mapped sentence for the code; the numeric status of an HTTP answer; never a body or a header. */
function failure(error: ErrorInfo): string {
  return t(testErrorKey(error), { status: error.detail ?? "", message: error.message });
}

/**
 * The result of a Test, inline under the row ((design notes: mcp-management-spec) 7.5). It shows exactly the fields of `McpTestReport`, never a
 * header, a URL query, an environment value or a response body. The outcome is announced through a polite live region.
 */
export function TestPanel(props: TestPanelProps) {
  const report = () => (props.state.status === "done" ? props.state.report : undefined);
  const failed = (): ErrorInfo | undefined => {
    const s = props.state;
    if (s.status === "failed") return s.error;
    return s.status === "done" && !s.report.ok ? (s.report.error ?? { code: "unknown", message: t("mcp.test.failed") }) : undefined;
  };
  const okLine = (r: McpTestReport) => t("mcp.test.ok", { seconds: seconds(r.ms), server: r.serverInfo?.name ?? props.name, count: r.toolCount });
  const readOnlyCount = (r: McpTestReport) => r.tools.filter((x) => x.readOnlyHint === true).length;
  const announcement = createMemo(() => {
    const r = report();
    if (props.state.status === "running") return t("mcp.test.running", { name: props.name });
    if (r?.ok) return okLine(r);
    const f = failed();
    return f ? failure(f) : "";
  });

  return (
    <div class="mcp-test" role="region" aria-label={t("mcp.test.panel", { name: props.name })} aria-busy={props.state.status === "running"} data-state={props.state.status === "running" ? "running" : failed() ? "failed" : "ok"}>
      <LiveRegion message={announcement()} />
      <Show when={props.state.status === "running"}>
        <p class="mcp-test__running"><Spinner size={14} /> {t("mcp.test.running", { name: props.name })}</p>
      </Show>
      <Show when={failed()}>
        {(error) => (
          <div class="mcp-note" data-tone="danger">
            <CircleAlert size={14} aria-hidden="true" />
            <div class="mcp-note__text">
              <p>{failure(error())}</p>
              <Show when={report()?.stderrTail?.trim()}>
                {(tail) => (
                  <details class="mcp-details">
                    <summary>{t("mcp.test.stderr")}</summary>
                    <pre class="mcp-pre">{tail()}</pre>
                  </details>
                )}
              </Show>
              <Show when={error().code === "mcpTimeout" && props.onRetryLong}>
                <Button size="sm" variant="secondary" onClick={props.onRetryLong}>{t("mcp.test.again30")}</Button>
              </Show>
            </div>
          </div>
        )}
      </Show>
      <Show when={report()?.ok ? report() : undefined}>
        {(r) => (
          <div class="mcp-test__ok">
            <p class="mcp-test__headline"><CircleCheck size={14} aria-hidden="true" /> {okLine(r())}</p>
            <ul class="mcp-test__facts">
              <Show when={readOnlyCount(r()) > 0}>
                <li>{t("mcp.test.readOnlyCount", { count: readOnlyCount(r()) })}</li>
              </Show>
              <Show when={r().tools.length > 0 && r().tools.every((x) => x.readOnlyHint === null)}>
                <li>{t("mcp.test.noAnnotations")}</li>
              </Show>
              <Show when={r().newTools.length > 0}>
                <li>{t("mcp.test.newTools", { names: list(r().newTools) })}</li>
              </Show>
              <Show when={r().removedTools.length > 0}>
                <li>{t("mcp.test.removedTools", { names: list(r().removedTools) })}</li>
              </Show>
              <Show when={r().blockedByDefault.length > 0}>
                <li class="mcp-test__warn">{t("mcp.test.blocked", { names: list(r().blockedByDefault) })}</li>
              </Show>
              <Show when={r().truncated}>
                <li>{t("mcp.test.truncated", { count: r().toolCount })}</li>
              </Show>
              <Show when={r().instructionsChanged}>
                <li class="mcp-test__warn">{t("mcp.test.instructionsChanged")}</li>
              </Show>
            </ul>
            <Show when={r().instructions}>
              {(text) => (
                <details class="mcp-details">
                  <summary>{t("mcp.test.instructions")}</summary>
                  <pre class="mcp-pre">{text()}</pre>
                </details>
              )}
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
