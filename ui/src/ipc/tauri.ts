import { call, subscribe } from "./rpc";
import type { Ipc } from "./index";
import { createTauriNamespaces } from "./namespaces";

export { toEngineError } from "./rpc";

export function createTauriIpc(): Ipc {
  return {
    workspaceGet: () => call("workspace_get"),
    workspaceSave: (ws) => call("workspace_save", { ws }),
    engineStatus: () => call("engine_status"),
    snapshotGet: (repoId) => call("snapshot_get", { repoId }),
    snapshotRefresh: (repoId) => call("snapshot_refresh", { repoId }),
    listUntracked: (repoId, dir, limit) => call("list_untracked", { repoId, dir, limit }),
    fileContents: (repoId, path, origPath, source, reveal) =>
      call("file_contents", { repoId, path, origPath, source, reveal }),
    fileHunks: (repoId, path, source) => call("file_hunks", { repoId, path, source }),
    commitMessageLast: (repoId) => call("commit_message_last", { repoId }),
    commitStart: (req) => call("commit_start", { req }),
    commitCancel: (runId) => call("commit_cancel", { runId }),
    pushPlan: (repoIds, refetch) => call("push_plan", { repoIds, refetch }),
    pushCommitFiles: (repoId, oid) => call("push_commit_files", { repoId, oid }),
    pushStart: (req) => call("push_start", { req }),
    pushCancel: (runId) => call("push_cancel", { runId }),
    pull: (repoId, mode) => call("pull", { repoId, mode }),
    fetch: (repoId) => call("fetch", { repoId }),
    setPushTarget: (repoId, localBranch, remote, branch) =>
      call("set_push_target", { repoId, localBranch, remote, branch }),
    doctor: () => call("doctor"),

    agentRoles: () => call("agent_roles"),
    agentsAutoInfo: (repoIds, mode) => call("agents_auto_info", { repoIds, ...(mode ? { mode } : {}) }),
    agentStart: (req, opts) => call("agent_start", { req, ...(opts?.runWithoutSafetyNet ? { runWithoutSafetyNet: true } : {}), ...(opts?.confirmBypass ? { confirmBypass: true } : {}) }),
    agentSend: (agentId, text, attachments, files) => call("agent_send", { agentId, text, attachments, files }),
    agentInterrupt: (agentId) => call("agent_interrupt", { agentId }),
    agentNote: (agentId, parentToolId, text) => call("agent_note", { agentId, parentToolId: parentToolId ?? null, text }),
    agentAnswerPermission: (agentId, requestId, decision, extra) => call("agent_answer_permission", { agentId, requestId, decision, ...(extra?.mode ? { mode: extra.mode } : {}), ...(extra?.feedback ? { feedback: extra.feedback } : {}) }),
    agentSetPermission: (agentId, mode, opts) => call("agent_set_permission", { agentId, mode, ...(opts?.confirmBypass ? { confirmBypass: true } : {}) }),
    agentModes: (provider) => call("agent_modes", { provider }),
    agentMcpStatus: (agentId) => call("agent_mcp_status", { agentId }),
    agentMcpReconnect: (agentId, server) => call("agent_mcp_reconnect", { agentId, server }),
    agentAnswerQuestion: (agentId, requestId, answer) => call("agent_answer_question", { agentId, requestId, answer }),
    agentList: () => call("agent_list"),
    agentHistory: (agentId, afterSeq) => call("agent_history", { agentId, afterSeq }),
    agentRewind: (agentId) => call("agent_rewind", { agentId }),
    agentRepoFiles: (repoId, query, limit) => call("agent_repo_files", { repoId, query, limit }),
    execSurfaceCheck: (paths) => call("exec_surface_check", { paths }),

    onRepoSnapshot: (cb) => subscribe("repo:snapshot", cb),
    onOpEvent: (cb) => subscribe("op:event", cb),
    onOpResult: (cb) => subscribe("op:result", cb),
    onEngineEnv: (cb) => subscribe("engine:env", cb),
    onAgentEvents: (cb) => subscribe("agent:events", cb),

    ...createTauriNamespaces(),
  };
}
