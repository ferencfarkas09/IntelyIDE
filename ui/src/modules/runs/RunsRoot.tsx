import { onMount } from "solid-js";
import { startAgentStore } from "../../store/agents";
import { startNotifier } from "./notifications";
import { NewRunDialog } from "./NewRunDialog";
import { loadRoleColors } from "./roleColors";

/** Mounted under the shell in both modes: keeps the agent store running (badges, notifications) and hosts the New run dialog. */
export default function RunsRoot() {
  onMount(() => {
    startAgentStore();
    loadRoleColors();
    startNotifier();
  });
  return <NewRunDialog />;
}
