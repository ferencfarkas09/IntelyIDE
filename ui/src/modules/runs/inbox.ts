import { createMemo, createRoot } from "solid-js";
import { agentRows, agentView } from "../../store/agents";
import { collectInbox } from "./inboxLogic";

/** Open requests across all runs. Reads the stores, so any component or effect tracking it updates live. */
export const inbox = createRoot(() => createMemo(() => collectInbox(agentRows(), agentView)));
export const inboxCount = (): number => inbox().length;
