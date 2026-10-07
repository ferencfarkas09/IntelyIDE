import type { AgentEvent, EventPayload } from "../../store/agent-types";
import type { RewindFile } from "../runsInspect";
import type { RunSummary } from "../runs";
import { isShowcase, SHOWCASE_ADMIN_PATH } from "./showcase";

/** Deterministic finished runs for the History, Inspector, Rewind and Review UIs in the browser and in tests. */
const NOW = Date.UTC(2026, 9, 3, 11, 0, 0);
const MIN = 60_000;
const ADMIN = isShowcase() ? SHOWCASE_ADMIN_PATH : "/Users/example/Projects/admin";

const TABLE_OLD = [
  "import { For } from \"solid-js\";",
  "",
  "export function OrdersTable(props: { orders: Order[] }) {",
  "  const total = (o: Order) => o.total.toFixed(2);",
  "  return (",
  "    <table>",
  "      <For each={props.orders}>",
  "        {(o) => (",
  "          <tr>",
  "            <td>{o.id}</td>",
  "            <td>{total(o)}</td>",
  "          </tr>",
  "        )}",
  "      </For>",
  "    </table>",
  "  );",
  "}",
  "",
  "export const EMPTY_LABEL = \"No orders\";",
].join("\n");

const TABLE_NEW = [
  "import { For } from \"solid-js\";",
  "import { money } from \"../../../utils/format\";",
  "",
  "export function OrdersTable(props: { orders: Order[] }) {",
  "  const total = (o: Order) => money(o.total, o.currency);",
  "  return (",
  "    <table>",
  "      <For each={props.orders}>",
  "        {(o) => (",
  "          <tr>",
  "            <td>{o.id}</td>",
  "            <td>{total(o)}</td>",
  "          </tr>",
  "        )}",
  "      </For>",
  "    </table>",
  "  );",
  "}",
  "",
  "export const EMPTY_LABEL = \"Nincs rendelés\";",
].join("\n");

const HEADER_OLD = ["export function Header() {", "  return <header class=\"app-header\">Admin</header>;", "}"].join("\n");
const HEADER_NEW = ["export function Header() {", "  return <header class=\"app-header\" data-light>Admin</header>;", "}"].join("\n");

const SERVICE_NEW = ["export function accrue(order) {", "  return Math.floor(order.total / 100);", "}"].join("\n");

let seq = 0;
type Raw = Record<string, unknown>;
const ev = (agentId: string, ts: number, p: EventPayload, raw?: Raw): AgentEvent => ({ agentId, seq: ++seq, ts, turnId: "turn-1", provider: "claude", ...(raw ? { raw } : {}), ...p }) as AgentEvent;

function devLog(agentId: string): AgentEvent[] {
  seq = 0;
  const t0 = NOW - 130 * MIN;
  const e = (dt: number, p: EventPayload, raw?: Raw) => ev(agentId, t0 + dt, p, raw);
  const diff = (path: string, o: string, n: string | null) => ({ path, old: o, new: n ?? "" });
  return [
    e(0, { kind: "session.started", nativeId: "native-dev", model: "claude-sonnet-5-5", effective: { effort: "medium", permission: "edit" }, auth: { mode: "subscription", source: "none" }, assertions: [] }, {
      type: "system",
      subtype: "init",
      mcp_servers: [{ name: "github", status: "connected" }, { name: "sentry", status: "needs-auth" }],
      hooks: ["PreToolUse: agent-gate", "PostToolUse: format-on-save"],
    }),
    e(50, { kind: "user.message", messageId: "u1", text: "Show prices with the currency in the order list and switch the empty label to Hungarian" }),
    e(120, { kind: "status", state: "thinking" }),
    e(600, { kind: "tool.start", toolId: "t1", name: "Read", toolKind: "read", input: { file_path: `${ADMIN}/src/components/modules/orders/OrdersTable.tsx` } }),
    e(780, { kind: "tool.result", toolId: "t1", status: "ok", output: "…", durationMs: 180 }),
    e(900, { kind: "tool.start", toolId: "s1", name: "Task", toolKind: "other", input: { subagent_type: "explorer", description: "find money() callers" } }),
    e(960, { kind: "tool.start", toolId: "t2", name: "Grep", toolKind: "search", input: { pattern: "toFixed" }, parentToolId: "s1" }),
    e(1210, { kind: "tool.result", toolId: "t2", status: "ok", output: "3 matches", durationMs: 250 }),
    e(1260, { kind: "tool.start", toolId: "t3", name: "Read", toolKind: "read", input: { file_path: "src/utils/format.ts" }, parentToolId: "s1" }),
    e(1400, { kind: "tool.result", toolId: "t3", status: "ok", output: "…", durationMs: 140 }),
    e(2100, { kind: "tool.result", toolId: "s1", status: "ok", output: "Two call sites: OrdersTable and Dashboard.", durationMs: 1200 }),
    e(2400, { kind: "tool.start", toolId: "t4", name: "Edit", toolKind: "edit", input: { file_path: `${ADMIN}/src/components/modules/orders/OrdersTable.tsx` } }),
    e(2720, { kind: "tool.result", toolId: "t4", status: "ok", output: "Edited 1 file", diff: diff(`${ADMIN}/src/components/modules/orders/OrdersTable.tsx`, TABLE_OLD, TABLE_NEW), durationMs: 320 }),
    e(3000, { kind: "tool.start", toolId: "t5", name: "Edit", toolKind: "edit", input: { file_path: "src/components/layout/Header.tsx" } }),
    e(3150, { kind: "tool.result", toolId: "t5", status: "ok", output: "Edited 1 file", diff: diff("src/components/layout/Header.tsx", HEADER_OLD, HEADER_NEW), durationMs: 150 }),
    e(3300, { kind: "usage", usage: usage(5200, 640, 0.024) }, { rssBytes: 412_000_000 }),
    e(3500, { kind: "tool.start", toolId: "t6", name: "Bash", toolKind: "exec", input: { command: "pnpm tsc --noEmit" } }),
    e(9500, { kind: "tool.result", toolId: "t6", status: "error", output: "OrdersTable.tsx(5,40): error TS2339: Property 'currency' does not exist on type 'Order'.", durationMs: 6000 }),
    e(9600, { kind: "error", class: "network", message: "The connection to the Claude API was reset (ECONNRESET).", retryable: true }),
    e(9700, { kind: "status", state: "throttled", retryAfterMs: 30_000, scope: "Claude subscription, 5-hour window" }),
    e(39_800, { kind: "status", state: "running" }),
    e(40_000, { kind: "tool.start", toolId: "t7", name: "Write", toolKind: "edit", input: { file_path: "src/api/services/loyaltyService.js" } }),
    e(40_120, { kind: "tool.result", toolId: "t7", status: "ok", output: "Created", diff: { path: "src/api/services/loyaltyService.js", old: null, new: SERVICE_NEW }, durationMs: 120 }),
    e(41_000, { kind: "text.delta", messageId: "m1", text: "Prices now use `money()`. " }),
    e(41_100, { kind: "text.done", messageId: "m1", text: "Prices now use `money()`. The type check still needs `currency` on `Order`." }),
    e(41_200, { kind: "usage", usage: usage(9100, 1480, 0.049) }, { rssBytes: 468_000_000 }),
    e(41_300, { kind: "status", state: "idle" }),
    e(41_400, { kind: "turn.end", stopReason: "endTurn" }),
  ];
}

function usage(input: number, output: number, usd: number): Extract<EventPayload, { kind: "usage" }>["usage"] {
  const counts = { inputTokens: input, outputTokens: output, cacheRead: Math.round(input * 0.6), cacheWrite: Math.round(input * 0.1), reasoningTokens: 0, costUsd: usd };
  return { model: "claude-sonnet-5-5", costBasis: "subscription", perTurn: counts, cumulative: counts, contextSize: 200_000, contextUsed: input };
}

function simpleLog(agentId: string, model: string, prompt: string, answer: string): AgentEvent[] {
  seq = 0;
  const t0 = NOW - 24 * 60 * MIN;
  const e = (dt: number, p: EventPayload) => ev(agentId, t0 + dt, p);
  return [
    e(0, { kind: "session.started", nativeId: `native-${agentId}`, model, effective: { permission: "readOnly" } }),
    e(40, { kind: "user.message", messageId: "u1", text: prompt }),
    e(300, { kind: "tool.start", toolId: "t1", name: "Grep", toolKind: "search", input: { pattern: "orders" } }),
    e(520, { kind: "tool.result", toolId: "t1", status: "ok", output: "src/api/routes/orders.js:12", durationMs: 220 }),
    e(900, { kind: "text.done", messageId: "m1", text: answer }),
    e(950, { kind: "usage", usage: usage(2100, 240, 0.011) }),
    e(1000, { kind: "turn.end", stopReason: "endTurn" }),
  ];
}

const RUNS: (RunSummary & { prompt: string })[] = [
  { id: "run-dev", roleId: "developer", title: "Show prices with the currency in the order list", prompt: "Show prices with the currency in the order list", status: "done", startedMs: NOW - 130 * MIN, repoIds: ["admin", "backend"], model: "claude-sonnet-5-5", costUsd: 0.049 },
  { id: "run-rev", roleId: "reviewer", title: "Review the OrderRow change", prompt: "Review the OrderRow change", status: "done", startedMs: NOW - 24 * 60 * MIN, repoIds: ["admin"], model: "claude-sonnet-5-5", costUsd: 0.011 },
  { id: "run-res", roleId: "researcher", title: "Which routes touch the orders table?", prompt: "Which routes touch the orders table?", status: "done", startedMs: NOW - 3 * 24 * 60 * MIN, repoIds: ["backend", "admin"], model: "claude-haiku-4-5-20251001", costUsd: 0.004 },
  { id: "run-fail", roleId: "architect", title: "Plan the loyalty points rollout", prompt: "Plan the loyalty points rollout", status: "failed", startedMs: NOW - 9 * 24 * 60 * MIN, repoIds: ["backend"], model: "claude-opus-5-5", costUsd: 0.21 },
  { id: "run-old", roleId: "researcher", title: "Where is the invoice number generated?", prompt: "Where is the invoice number generated?", status: "done", startedMs: NOW - 45 * 24 * 60 * MIN, repoIds: ["backend"], model: "claude-haiku-4-5-20251001", costUsd: 0.002, transcriptExpired: true },
];

export const FIXTURE_RUNS = (): RunSummary[] => RUNS.map(({ prompt: _prompt, ...r }) => ({ ...r }));

const LOGS: Record<string, () => AgentEvent[]> = {
  "run-dev": () => devLog("run-dev"),
  "run-rev": () => simpleLog("run-rev", "claude-sonnet-5-5", "Review the OrderRow change", "No blocking issues in `OrderRow.tsx`; one nit on naming."),
  "run-res": () => simpleLog("run-res", "claude-haiku-4-5-20251001", "Which routes touch the orders table?", "`routes/orders.js` and `services/orderService.js` read it."),
  "run-fail": () => simpleLog("run-fail", "claude-opus-5-5", "Plan the loyalty points rollout", "The rollout needs a migration first."),
};

export const fixtureEvents = (runId: string): AgentEvent[] | undefined => LOGS[runId]?.();
export const fixturePrompt = (runId: string): string => RUNS.find((r) => r.id === runId)?.prompt ?? "";

/** Snapshots the run took, and the files a restore to each would change. */
export const FIXTURE_SNAPSHOTS: Record<string, { id: string; repoId: string; takenMs: number; label: string; files: RewindFile[] }[]> = {
  "run-dev": [
    {
      id: "snap-dev-1",
      repoId: "admin",
      takenMs: NOW - 130 * MIN,
      label: "Before the run",
      files: [
        { repoId: "admin", path: "src/components/modules/orders/OrdersTable.tsx", change: "modified" },
        { repoId: "admin", path: "src/components/layout/Header.tsx", change: "modified" },
      ],
    },
    { id: "snap-dev-2", repoId: "backend", takenMs: NOW - 130 * MIN, label: "Before the run", files: [{ repoId: "backend", path: "src/api/services/loyaltyService.js", change: "created" }] },
  ],
  "run-fail": [{ id: "snap-fail-1", repoId: "backend", takenMs: NOW - 9 * 24 * 60 * MIN, label: "Before the run", files: [] }],
};
