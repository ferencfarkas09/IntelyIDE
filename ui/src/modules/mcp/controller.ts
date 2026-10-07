import { createEffect, createSignal, on, onCleanup } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { McpList, McpPolicyPatch, McpServerView, McpWorkspaceState } from "../../ipc/mcp";
import type { SecretsStatus } from "../../ipc/settings";
import { errorText } from "../../store/snapshots";
import { activeId } from "../../store/workspaces";
import { toast } from "../../ui-kit";
import { applyPolicyPatch, editorErrorKey, errorInfo, type ErrorInfo } from "./logic";
import type { TestState } from "./TestPanel";

export type McpMeta = Omit<McpList, "servers">;

/**
 * The state behind the MCP section: the list as the backend sends it (kept in a store keyed by server id, so a refresh updates a row in
 * place and never remounts it under the user's hands), the last Test of every server, and the few commands whose answer is not simply a
 * new view. The backend is the only source of truth: a refresh follows every command and every `settings:changed` of the namespace `mcp`.
 */
export function createMcpController() {
  const [data, setData] = createStore<{ servers: McpServerView[] }>({ servers: [] });
  const [meta, setMeta] = createSignal<McpMeta | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [secrets, setSecrets] = createSignal<SecretsStatus | null>(null);
  const [tests, setTests] = createSignal<Record<string, TestState>>({});
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function refresh(): Promise<void> {
    const mine = ++generation;
    try {
      const list = await ipc.mcp.list(activeId());
      if (mine !== generation) return;
      const { servers, ...rest } = list;
      setData("servers", reconcile(servers, { key: "id", merge: true }));
      setMeta(rest);
      setError(null);
    } catch (e) {
      if (mine === generation) setError(errorText(e));
    } finally {
      if (mine === generation) setLoading(false);
    }
    void ipc.secrets.status().then(setSecrets, () => {});
  }

  /** Coalesces the refresh that follows a command with the `settings:changed` that the same command fires. */
  function scheduleRefresh(): void {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), 60);
  }

  onCleanup(() => clearTimeout(timer));
  onCleanup(ipc.settings.onChange((e) => e.ns === "mcp" && scheduleRefresh()));
  createEffect(on(activeId, () => void refresh()));

  const server = (id: string | null | undefined) => (id ? data.servers.find((s) => s.id === id) : undefined);

  /** Puts the view a command answered with into the list at once (a new server is added at the end). */
  function applyView(view: McpServerView): void {
    if (data.servers.some((s) => s.id === view.id)) setData("servers", (s) => s.id === view.id, reconcile(view, { merge: true }));
    else setData("servers", (list) => [...list, view]);
    scheduleRefresh();
  }

  async function runTest(id: string, timeoutMs?: number): Promise<ErrorInfo | undefined> {
    setTests((all) => ({ ...all, [id]: { status: "running" } }));
    try {
      const report = await ipc.mcp.test(id, timeoutMs);
      setTests((all) => ({ ...all, [id]: { status: "done", report } }));
      scheduleRefresh();
      return undefined;
    } catch (e) {
      const info = errorInfo(e);
      setTests((all) => ({ ...all, [id]: { status: "failed", error: info } }));
      scheduleRefresh();
      return info;
    }
  }

  const dropTest = (id: string) => setTests((all) => Object.fromEntries(Object.entries(all).filter(([k]) => k !== id)));

  /** The caller opens the confirm dialog when the answer is `confirmationRequired`; every other failure is a toast. */
  async function setEnabled(id: string, enabled: boolean): Promise<ErrorInfo | undefined> {
    try {
      applyView(await ipc.mcp.setEnabled(id, enabled));
      return undefined;
    } catch (e) {
      const info = errorInfo(e);
      if (info.code !== "confirmationRequired") toast.error(t(editorErrorKey(info.code), { message: info.message }));
      scheduleRefresh();
      return info;
    }
  }

  /** Optimistic: the row shows the choice at once; a refusal puts the backend's state back and says why. */
  async function patchPolicy(id: string, patch: McpPolicyPatch): Promise<void> {
    setData("servers", (s) => s.id === id, produce((s) => applyPolicyPatch(s, patch)));
    try {
      applyView(await ipc.mcp.setPolicy(id, patch));
    } catch (e) {
      const info = errorInfo(e);
      toast.error(t(editorErrorKey(info.code), { message: info.message }));
      await refresh();
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await ipc.mcp.remove(id);
      dropTest(id);
      await refresh();
    } catch (e) {
      const info = errorInfo(e);
      toast.error(t(editorErrorKey(info.code), { message: info.message }));
    }
  }

  async function setWorkspace(serverId: string, state: McpWorkspaceState): Promise<void> {
    const workspaceId = activeId();
    if (!workspaceId) return;
    try {
      const list = await ipc.mcp.workspaceSet(workspaceId, serverId, state);
      const { servers, ...rest } = list;
      setData("servers", reconcile(servers, { key: "id", merge: true }));
      setMeta(rest);
    } catch (e) {
      const info = errorInfo(e);
      toast.error(t(editorErrorKey(info.code), { message: info.message }));
      await refresh();
    }
  }

  async function retryKeychain(): Promise<void> {
    try {
      await ipc.secrets.retryKeychain();
      setSecrets(await ipc.secrets.status());
      await refresh();
    } catch (e) {
      toast.error(t("secretstore.retryFailed"), errorText(e));
    }
  }

  return { servers: () => data.servers, server, meta, loading, error, secrets, tests, refresh, scheduleRefresh, applyView, runTest, dropTest, setEnabled, patchPolicy, remove, setWorkspace, retryKeychain };
}

export type McpController = ReturnType<typeof createMcpController>;
