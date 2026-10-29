import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { SendToAgentMenu } from "../../components/SendToAgentMenu";
import { registerCommand } from "../../platform/commands";
import { takeNewRunPrefill } from "../../platform/newRun";
import { installDomStubs } from "../../store/testing-u2";
import { setSendToAgentEnabled } from "./toggle";

installDomStubs();
let off: (() => void) | undefined;
afterEach(() => {
  cleanup();
  off?.();
  takeNewRunPrefill();
  setSendToAgentEnabled(true);
});

describe("the Fix with agent menu", () => {
  it("opens the New Run dialog with the masked error and the repository", async () => {
    off = registerCommand({ id: "runs.new", title: "New run", group: "Runs", run: () => {} });
    render(() => <SendToAgentMenu collect={() => ({ kind: "script", text: "npm ERR! password=hunter2 failed", repoId: "api" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Ask the agent about this error" }));
    fireEvent.click(await screen.findByText("Explain this error"));
    let prefill: ReturnType<typeof takeNewRunPrefill>;
    await waitFor(() => expect((prefill = takeNewRunPrefill())).toBeTruthy());
    expect(prefill!.repoIds).toEqual(["api"]);
    expect(prefill!.prompt).toContain("Explain this error from a script I ran");
    expect(prefill!.prompt).not.toContain("hunter2");
  });

  it("is hidden while the extra is off", () => {
    setSendToAgentEnabled(false);
    render(() => <SendToAgentMenu collect={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Ask the agent about this error" })).toBeNull();
  });
});
