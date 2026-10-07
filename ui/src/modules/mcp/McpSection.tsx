import { createMemo, createSignal, For, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { McpImportResult, McpServerView, McpWorkspaceState } from "../../ipc/mcp";
import { activeId, activeSummary } from "../../store/workspaces";
import { announce, Button, Dialog, EmptyState, Plug, Skeleton, SplitButton, toast, TriangleAlert, Upload } from "../../ui-kit";
import { ConfirmRunDialog } from "./ConfirmRunDialog";
import { createMcpController } from "./controller";
import { ImportDialog } from "./ImportDialog";
import { errorInfo, workspaceState } from "./logic";
import { ServerEditor } from "./ServerEditor";
import { ServerRow } from "./ServerRow";
import "./mcp.css";

/** What a confirmation was asked for: a Test (the primary button then says "Confirm and test") or the On-by-default switch. */
type ConfirmIntent = "test" | "enable";

/**
 * Settings > MCP servers ((design notes: mcp-management-spec) 7): the servers the user chose, one row each, with the confirmation that is the only
 * control for "run this program", the Test with its learned tools and rules, the per-workspace switch and the import from Claude Code.
 * Secrets are written through the editor only and are never read back.
 */
export default function McpSection() {
  const c = createMcpController();
  const [editor, setEditor] = createSignal<{ id?: string } | null>(null);
  const [confirm, setConfirm] = createSignal<{ id: string; then: ConfirmIntent; changed: boolean } | null>(null);
  const [removing, setRemoving] = createSignal<string | null>(null);
  const [importing, setImporting] = createSignal(false);
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());

  const meta = () => c.meta();
  const jail = () => meta()?.jail === "readOnly";
  const newer = () => meta()?.readOnlyReason === "newerSchema";
  const frozen = () => jail() || newer();
  const names = createMemo(() => c.servers().map((s) => s.name));
  const editing = () => c.server(editor()?.id);
  const workspaceName = () => activeSummary()?.name ?? activeId() ?? "";

  const toggleExpanded = (id: string, force?: boolean) =>
    setExpanded((all) => {
      const next = new Set(all);
      if (force ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });

  /** A Test needs a confirmed record: the dialog first, then the Test. */
  async function startTest(s: McpServerView, timeoutMs?: number) {
    if (!s.confirmed) {
      setConfirm({ id: s.id, then: "test", changed: false });
      return;
    }
    toggleExpanded(s.id, true);
    const failure = await c.runTest(s.id, timeoutMs);
    if (failure?.code === "confirmationRequired") {
      await c.refresh();
      setConfirm({ id: s.id, then: "test", changed: true });
    }
  }

  async function enable(s: McpServerView, next: boolean) {
    if (next && !s.confirmed) {
      setConfirm({ id: s.id, then: "enable", changed: false });
      return;
    }
    const failure = await c.setEnabled(s.id, next);
    if (failure?.code === "confirmationRequired") {
      await c.refresh();
      setConfirm({ id: s.id, then: "enable", changed: true });
    }
  }

  async function confirmNow() {
    const req = confirm();
    const s = c.server(req?.id);
    if (!req || !s) return;
    try {
      const view = await ipc.mcp.confirm(s.id, s.confirmHash);
      c.applyView(view);
      setConfirm(null);
      if (req.then === "test") void startTest(view);
      else if (req.then === "enable") void c.setEnabled(view.id, true);
    } catch (e) {
      const info = errorInfo(e);
      if (info.code === "confirmationRequired") {
        // the record or a file it runs changed under the open dialog: the list is read again and the dialog shows the new text
        await c.refresh();
        setConfirm({ ...req, changed: true });
      } else {
        setConfirm(null);
        toast.error(info.message || info.code);
      }
    }
  }

  function saved(view: McpServerView, thenTest: boolean) {
    c.applyView(view);
    setEditor(null);
    if (thenTest) void startTest(view);
  }

  function imported(result: McpImportResult) {
    if (result.imported.length > 0) toast.success(t("mcp.import.done", { count: result.imported.length }));
    if (result.skipped.length > 0) toast.warn(t("mcp.import.skipped", { count: result.skipped.length }));
    announce(t("mcp.import.done", { count: result.imported.length }));
    c.scheduleRefresh();
  }

  const removeTarget = () => c.server(removing());
  async function removeNow() {
    const id = removing();
    setRemoving(null);
    if (id) await c.remove(id);
  }

  const addButtons = (
    <>
      <Button variant="primary" icon={Plug} disabled={frozen()} onClick={() => setEditor({})}>{t("mcp.add")}</Button>
      <Button variant="secondary" icon={Upload} disabled={frozen()} onClick={() => setImporting(true)}>{t("mcp.import")}</Button>
    </>
  );

  return (
    <div class="mcp">
      <Show when={meta()}>
        <div class="mcp__banners">
          <Show when={newer()}>
            <div class="mcp-note" data-tone="warn" role="status"><TriangleAlert size={14} aria-hidden="true" /><span class="mcp-note__text">{t("mcp.banner.newer")}</span></div>
          </Show>
          <Show when={jail()}>
            <div class="mcp-note" data-tone="warn" role="status"><TriangleAlert size={14} aria-hidden="true" /><span class="mcp-note__text">{t("mcp.banner.readOnly")}</span></div>
          </Show>
          <Show when={c.secrets()?.degraded}>
            <div class="mcp-note" data-tone="warn" role="status">
              <TriangleAlert size={14} aria-hidden="true" />
              <span class="mcp-note__text">{c.secrets()?.message ?? t("secretstore.degraded")}</span>
              <Button size="sm" variant="secondary" onClick={() => void c.retryKeychain()}>{t("secretstore.retry")}</Button>
            </div>
          </Show>
        </div>
      </Show>

      <div class="mcp__head">
        <p class="mcp__intro">{t("mcp.intro")}</p>
        <Show when={meta() && (c.servers().length > 0 || (meta()?.problems.length ?? 0) > 0)}>
          <SplitButton
            icon={Plug}
            disabled={frozen()}
            menuLabel={t("mcp.addMore")}
            onClick={() => setEditor({})}
            items={[{ label: t("mcp.import"), icon: Upload, onSelect: () => setImporting(true) }]}
          >
            {t("mcp.add")}
          </SplitButton>
        </Show>
      </div>

      <Show
        when={!c.error()}
        fallback={
          <div class="mcp-note" data-tone="danger" role="alert">
            <TriangleAlert size={14} aria-hidden="true" />
            <span class="mcp-note__text">{t("mcp.error.load")} {c.error()}</span>
            <Button size="sm" variant="secondary" onClick={() => void c.refresh()}>{t("mcp.retry")}</Button>
          </div>
        }
      >
        <Show
          when={!c.loading()}
          fallback={
            <div class="mcp__loading" role="status" aria-busy="true" aria-label={t("mcp.loading")}>
              <Skeleton height={76} />
              <Skeleton height={76} />
              <Skeleton height={76} />
            </div>
          }
        >
          <Show
            when={c.servers().length > 0 || (meta()?.problems.length ?? 0) > 0}
            fallback={<EmptyState icon={Plug} title={t("mcp.empty.title")} description={t("mcp.empty.text")} action={<div class="mcp__empty-actions">{addButtons}</div>} />}
          >
            <ul class="mcp__list" role="list">
              <For each={c.servers()}>
                {(server) => (
                  <ServerRow
                    server={server}
                    readOnly={frozen()}
                    testBlockedReason={jail() ? t("mcp.banner.readOnly") : undefined}
                    expanded={expanded().has(server.id)}
                    onToggleExpanded={() => toggleExpanded(server.id)}
                    test={c.tests()[server.id]}
                    workspace={activeId() ? { id: activeId()!, name: workspaceName(), state: workspaceState({ workspace: meta()?.workspace ?? { id: null, overrides: [] } }, server.id) } : null}
                    onTest={(timeoutMs) => void startTest(server, timeoutMs)}
                    onEdit={() => setEditor({ id: server.id })}
                    onRemove={() => setRemoving(server.id)}
                    onEnable={(next) => void enable(server, next)}
                    onPatch={(patch) => c.patchPolicy(server.id, patch)}
                    onWorkspace={(state: McpWorkspaceState) => void c.setWorkspace(server.id, state)}
                  />
                )}
              </For>
              <For each={meta()?.problems ?? []}>
                {(problem) => (
                  <li class="mcp-problem">
                    <TriangleAlert size={14} aria-hidden="true" />
                    <span class="mcp-problem__text">{t("mcp.problem.entry", { reason: problem.reason })}</span>
                    <Button size="sm" variant="ghost" disabled={frozen()} onClick={() => void c.remove(`index:${problem.index}`)}>{t("mcp.problem.remove")}</Button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </Show>

      <ServerEditor
        open={!!editor()}
        server={editing()}
        existingNames={names().filter((n) => n !== editing()?.name)}
        readOnly={frozen()}
        onClose={() => setEditor(null)}
        onSaved={saved}
      />
      <ConfirmRunDialog
        open={!!confirm()}
        server={c.server(confirm()?.id)}
        thenTest={confirm()?.then === "test"}
        changed={confirm()?.changed}
        onCancel={() => setConfirm(null)}
        onConfirm={confirmNow}
      />
      <ImportDialog open={importing()} existingNames={names()} onClose={() => setImporting(false)} onDone={imported} />
      <Dialog
        open={!!removing()}
        onClose={() => setRemoving(null)}
        role="alertdialog"
        size="sm"
        title={t("mcp.remove.title", { name: removeTarget()?.name ?? "" })}
        description={t("mcp.remove.body")}
        footer={
          <>
            <Button variant="secondary" data-autofocus onClick={() => setRemoving(null)}>{t("mcp.cancel")}</Button>
            <Button variant="danger" onClick={() => void removeNow()}>{t("mcp.action.remove")}</Button>
          </>
        }
      />
    </div>
  );
}
