// Scripted ACP-style runs for the mock (providers-plan 5.7 "fake ACP agent"): they exercise the provider-aware UI without a CLI.
// Behaviours: thought chunks, an agent that decides what to ask, hard-stop denials of git writes, a crash mid-turn, a missing login,
// an unknown vendor method. Played for any run on a provider other than Claude; `?scenario=acp-...` picks one for the demo run.
import type { Ctx, Script } from "./mock-agent";

export const ACP_SCENARIOS = ["acp-research", "acp-denied", "acp-crash", "acp-login", "acp-vendor"] as const;
export type AcpScenario = (typeof ACP_SCENARIOS)[number];

const read = (c: Ctx) => c.tool("t1", { name: "Read", toolKind: "read", summary: "src/api/routes/orders.js", input: { file_path: "src/api/routes/orders.js" } }, { output: "router.get('/orders', list);\nrouter.post('/orders', create);", ms: 160 });

export const ACP_SCRIPTS: Record<AcpScenario, Script> = {
  "acp-research": async (c) => {
    c.emit({ kind: "status", state: "thinking" });
    for (const t of ["The question is which routes read the orders table. ", "I will grep the route files first, then the service layer."]) {
      c.emit({ kind: "thinking.delta", messageId: "th1", text: t });
      await c.wait(100);
    }
    c.emit({ kind: "status", state: "running" });
    await read(c);
    await c.tool("t2", { name: "Grep", toolKind: "search", summary: "orders in src/api", input: { pattern: "orders" } }, { output: "src/api/routes/orders.js:12\nsrc/api/services/orderService.js:30", ms: 220 });
    c.emit({ kind: "plan", items: [{ content: "Find route handlers", status: "done" }, { content: "Check the service layer for direct queries", status: "inProgress" }] });
    c.emit({ kind: "tool.start", toolId: "t3", name: "Bash", toolKind: "exec", summary: "git log --oneline -5 -- src/api/routes/orders.js", input: { command: "git log --oneline -5 -- src/api/routes/orders.js" } });
    const d = await c.permission("p1", "t3", { class: "exec", rawCommand: "git log --oneline -5 -- src/api/routes/orders.js", argv: ["git", "log", "--oneline", "-5", "--", "src/api/routes/orders.js"], summary: "Run `git log` (read-only) in backend" }, ["allowOnce", "deny"]);
    if (d === "deny") c.emit({ kind: "tool.result", toolId: "t3", status: "denied", output: "Denied by you" });
    else c.emit({ kind: "tool.result", toolId: "t3", status: "ok", output: "a1b2c3d Add order export\n9f8e7d6 Fix order total rounding", durationMs: 90 });
    await c.stream("m1", ["Two route files touch orders: `routes/orders.js` (list and create) and `services/orderService.js` (direct queries). ", d === "deny" ? "I could not read the history because you denied the command." : "The last change was the export on `a1b2c3d`."]);
    c.usage(2600, 330);
  },

  "acp-denied": async (c) => {
    c.emit({ kind: "status", state: "running" });
    await c.stream("m1", ["I will try to publish the fix myself. "]);
    await c.tool("t1", { name: "Bash", toolKind: "exec", summary: "/usr/bin/git push origin main", input: { command: "/usr/bin/git push origin main" } }, { status: "denied", output: "Blocked by policy (hard stop): git push. Agents never commit or push.", ms: 40 });
    await c.tool("t2", { name: "Write", toolKind: "edit", summary: "src/utils/format.ts", input: { file_path: "src/utils/format.ts" } }, { status: "denied", output: "Denied: this role is read-only on this provider.", ms: 30 });
    await c.stream("m2", ["Both were refused. The push is a hard stop and this role may only read, so I will describe the change instead: format totals with `Intl.NumberFormat` and keep the currency as a parameter."]);
    c.usage(1800, 240);
  },

  "acp-crash": async (c) => {
    c.emit({ kind: "status", state: "running" });
    if (c.retry === 0) {
      await c.stream("m1", ["Running the order tests to see what fails. "]);
      c.emit({ kind: "tool.start", toolId: "t1", name: "Bash", toolKind: "exec", summary: "pnpm vitest run src/api", input: { command: "pnpm vitest run src/api" } });
      await c.wait(300);
      c.emit({ kind: "tool.result", toolId: "t1", status: "error", output: "agent process exited (signal SIGKILL)" });
      c.emit({ kind: "error", class: "provider", message: "The agent process exited unexpectedly (code 1). Its slot was released and no approval is left pending.", retryable: true });
      c.fail();
    }
    await c.stream("m2", ["Back after the restart. Four tests failed in `orders.test.js`, all on the same rounding assertion."]);
    c.usage(2100, 260);
  },

  "acp-login": async (c) => {
    c.emit({ kind: "status", state: "running" });
    if (c.retry === 0) {
      c.emit({ kind: "error", class: "auth", message: "The provider needs a sign-in. Run its CLI once in a terminal, sign in, then send your message again.", retryable: false });
      c.fail();
    }
    await c.stream("m1", ["Signed in. Reading the order list now."]);
    c.usage(900, 80);
  },

  "acp-vendor": async (c) => {
    c.emit({ kind: "status", state: "running" });
    await read(c);
    c.emit({ kind: "error", class: "protocol", message: "Ignored the unknown vendor method `_vendor/ask_question`; it got a safe default reply so the turn did not hang.", retryable: false });
    await c.stream("m1", ["Continuing without that question. `routes/orders.js` defines the two order routes."]);
    c.usage(1500, 160);
  },
};
