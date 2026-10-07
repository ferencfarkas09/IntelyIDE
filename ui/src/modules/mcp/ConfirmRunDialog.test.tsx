import { cleanup, configure, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServerView } from "../../ipc/mcp";
import { installDomStubs } from "../../store/testing-u2";
import { ConfirmRunDialog } from "./ConfirmRunDialog";

configure({ asyncUtilTimeout: 15000 });
vi.setConfig({ testTimeout: 30000 });
installDomStubs();
afterEach(cleanup);

const server = (over: Partial<McpServerView> = {}): McpServerView => ({
  id: "m1", name: "github", transport: "stdio", command: "npx", args: [], env: [], headers: [], enabled: false, defaultPolicy: "ask", tools: [], toolsTestedAt: null, toolsStale: false,
  staleToolPolicies: [], serverInfo: null, state: "needsConfirm", confirmed: false, imported: false, confirmHash: "h".repeat(64), commandLine: "npx -y @modelcontextprotocol/server-github",
  argsDisplay: ["-y", "@modelcontextprotocol/server-github"], codeFiles: [], fetchesCode: false, createdAt: 0, updatedAt: 0, ...over,
});

const open = (s: McpServerView, extra: Partial<Parameters<typeof ConfirmRunDialog>[0]> = {}) => {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(() => <ConfirmRunDialog open server={s} onCancel={onCancel} onConfirm={onConfirm} {...extra} />);
  return { onCancel, onConfirm };
};

describe("<ConfirmRunDialog>", () => {
  it("is an alertdialog that says what is being run, with Cancel focused first and Confirm as the one primary button", async () => {
    const { onCancel, onConfirm } = open(server());
    const dlg = await screen.findByRole("alertdialog", { name: "Run this program?" });
    expect(within(dlg).getByText(/github is code you chose to run/)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(dlg).getByRole("button", { name: "Cancel" })));
    expect(within(dlg).getByRole("button", { name: "Confirm" }).getAttribute("data-variant")).toBe("primary");
    expect(within(dlg).getByRole("button", { name: "Cancel" }).getAttribute("data-variant")).toBe("secondary");
    fireEvent.click(within(dlg).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    fireEvent.click(within(dlg).getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("says 'Confirm and test' when a Test opened it", async () => {
    open(server(), { thenTest: true });
    expect(await screen.findByRole("button", { name: "Confirm and test" })).toBeTruthy();
  });

  it("shows a 4096-character argument in full, tail included, one list item per argument under the count", async () => {
    const long = `${"a".repeat(4090)}TAIL42`;
    open(server({ argsDisplay: ["-y", long, "last"] }));
    const list = await screen.findByRole("list", { name: "3 arguments" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[1].textContent).toBe(long);
    expect(items[1].textContent!.endsWith("TAIL42")).toBe(true);
    expect(screen.getByRole("heading", { name: "3 arguments" })).toBeTruthy();
  });

  it("renders the escaped text it was sent and never re-interprets it: a direction override and a line break arrive as \\u{..}", async () => {
    // what Rust sends for the stored text "x‮evil\nrm -rf" (the characters themselves cannot be stored at all)
    const sent = ["x\\u{202e}evil\\u{a}rm␣-rf", "␣lead", "trail␣␣", "a␣␣b"];
    open(server({ argsDisplay: sent }));
    const items = within(await screen.findByRole("list", { name: "4 arguments" })).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual(sent);
    expect(document.body.textContent).not.toContain("‮");
  });

  it("escapes the variable values it shows itself, and never shows a secret's value", async () => {
    open(server({ env: [{ name: "LOG_LEVEL", secret: false, value: "info‮", present: true }, { name: "GITHUB_TOKEN", secret: true, present: true }] }));
    const vars = await screen.findByText("Variables (secret values are not shown)");
    const block = vars.parentElement!;
    expect(within(block).getByText("LOG_LEVEL")).toBeTruthy();
    expect(within(block).getByText("info\\u{202e}")).toBeTruthy();
    expect(within(block).getByText("GITHUB_TOKEN")).toBeTruthy();
    expect(within(block).getByText("secret")).toBeTruthy();
  });

  it("shows an http server by its address and its host on its own line, with the note when the host is in encoded form", async () => {
    open(server({ name: "docs", transport: "http", command: undefined, commandLine: undefined, argsDisplay: [], url: "https://xn--hrnlmo-kva.example/mcp", urlHost: "xn--hrnlmo-kva.example", headers: [{ name: "Authorization", secret: true, present: true }] }));
    const dlg = await screen.findByRole("alertdialog", { name: "Connect to this service?" });
    expect(within(dlg).getByText("https://xn--hrnlmo-kva.example/mcp")).toBeTruthy();
    expect(within(dlg).getByText("Host (as it is sent)").nextElementSibling!.textContent).toBe("xn--hrnlmo-kva.example");
    expect(within(dlg).getByText(/uses an international name in its encoded form/)).toBeTruthy();
    expect(within(dlg).queryByText("Command")).toBeNull();
    expect(within(dlg).getByText("Authorization")).toBeTruthy();
  });

  it("has no international-name note for an ordinary host", async () => {
    open(server({ transport: "http", url: "https://docs.example.com/mcp", urlHost: "docs.example.com", argsDisplay: [] }));
    await screen.findByRole("alertdialog");
    expect(screen.queryByText(/international name/)).toBeNull();
  });

  it("lists the files the proof vouches for with the first 12 characters of their digests", async () => {
    open(server({ command: "node", argsDisplay: ["/Users/example/tools/server.mjs"], codeFiles: [{ path: "/opt/homebrew/bin/node", sha256: "0123456789ab" }, { path: "/Users/example/tools/server.mjs", sha256: "fedcba987654" }] }));
    const label = await screen.findByText(/Files this server runs/);
    const block = label.parentElement!;
    expect(within(block).getByText("/opt/homebrew/bin/node")).toBeTruthy();
    expect(within(block).getByText("0123456789ab")).toBeTruthy();
    expect(within(block).getByText("fedcba987654")).toBeTruthy();
  });

  it("warns about an unpinned package only when the code is fetched at every start", async () => {
    open(server({ fetchesCode: true }));
    expect(await screen.findByText(/downloaded from a registry every time it runs/)).toBeTruthy();
    cleanup();
    open(server({ fetchesCode: false }));
    await screen.findByRole("alertdialog");
    expect(screen.queryByText(/downloaded from a registry every time it runs/)).toBeNull();
  });

  it("warns that imported values are hidden only for an imported record that has a secret slot", async () => {
    const secret = [{ name: "GITHUB_TOKEN", secret: true, present: true }];
    open(server({ imported: true, env: secret }));
    expect(await screen.findByText("Some values came from the imported file and are hidden. Confirm only a file you trust.")).toBeTruthy();
    cleanup();
    open(server({ imported: false, env: secret }));
    await screen.findByRole("alertdialog");
    expect(screen.queryByText(/came from the imported file/)).toBeNull();
    cleanup();
    open(server({ imported: true, env: [{ name: "LOG_LEVEL", secret: false, value: "info", present: true }] }));
    await screen.findByRole("alertdialog");
    expect(screen.queryByText(/came from the imported file/)).toBeNull();
  });

  it("tells the user to read it again when the record changed under the open dialog", async () => {
    open(server(), { changed: true });
    expect(await screen.findByText(/The settings changed while this was open/)).toBeTruthy();
  });
});
