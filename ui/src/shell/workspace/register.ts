import { lazy } from "solid-js";
import { registerOverlay } from "../../platform/overlay";
import "./switcher.css";
import { registerDynamicWorkspaceCommands, registerWorkspaceCommands } from "./commands";

/** What the workspace feature contributes to the platform registries: its commands and its dialog hosts. Idempotent. */
export function registerWorkspaceShell(): void {
  registerWorkspaceCommands();
  registerDynamicWorkspaceCommands();
  registerOverlay({ id: "workspace.flows", component: lazy(() => import("./FlowDialogs")) });
  registerOverlay({ id: "workspace.guard", component: lazy(() => import("./SwitchGuard")) });
  registerOverlay({ id: "workspace.new", component: lazy(() => import("./NewWorkspaceDialog")) });
  registerOverlay({ id: "workspace.scan", component: lazy(() => import("./ScanDialog")) });
  registerOverlay({ id: "workspace.manage", component: lazy(() => import("./ManageDialog")) });
}
