// The one place that turns an error card into a task for the coding agent. It fills the New Run dialog through
// `requestNewRun` (nothing runs until the person presses Start run). When the shared `sendToAgent.buildErrorPrompt`
// lands, switch `buildPrompt` to it and keep the rest as it is.
import { requestNewRun } from "../../platform/newRun";
import type { ErrorCard, ProjectInfo } from "./types";

const SOURCE: Record<ErrorCard["source"], string> = { metro: "the Metro bundler output", ios: "the iOS simulator log", android: "the Android device log" };

/** English on purpose: the prompt is for the agent, not for the screen. The text was masked by the backend. */
export function buildPrompt(card: ErrorCard, project: ProjectInfo | undefined): string {
  const app = project ? `${project.kind === "expo" ? "Expo" : "React Native"} app "${project.name}"${project.rnVersion ? ` (react-native ${project.rnVersion})` : ""}` : "React Native app";
  const lines = [`My ${app} fails with this error, seen in ${SOURCE[card.source]}:`, "", "```", card.snippet, ...card.context, "```", ""];
  lines.push("Find the cause in the code and fix it. Explain the cause in plain words first, change as little as possible, and tell me how to check that it works. Do not run builds or deploys, and do not commit.");
  return lines.join("\n");
}

/** Opens the New Run dialog with the prompt; resolves false when the dialog could not be opened. */
export function fixWithAgent(card: ErrorCard, project: ProjectInfo | undefined, repoId: string): Promise<boolean> {
  return requestNewRun({ prompt: buildPrompt(card, project), repoIds: [repoId] });
}
