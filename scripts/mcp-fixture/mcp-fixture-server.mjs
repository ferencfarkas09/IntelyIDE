#!/usr/bin/env node
// A fixture MCP server for tests ((design notes: mcp-management-spec) 9.1): newline-delimited JSON-RPC 2.0 over stdio, no dependencies.
// It never reads or prints a secret on purpose: `env_has` answers true/false, `env_names` returns names only. The one exception is the mode
// `stderrenv` (prints the whole environment on stderr) and `exit` (prints FIXTURE_TOKEN on stderr), which exist to prove the scrubber.
//
// Environment (all optional):
//   FIXTURE_MODE          ok (default) | slow | hang | exit | badjson | big | many | noannotations | serverrequests | grandchild | stderrenv
//   FIXTURE_TOKEN         a value `exit` echoes on stderr (the canary of the scrubber tests)
//   FIXTURE_PIDFILE       writes "<server pid>" there ("<server pid> <grandchild pid>" in the mode `grandchild`)
//   FIXTURE_ECHO          the NAME of an environment variable whose value (and its bare token, percent-encoded, base64 and JSON-escaped
//                         forms) is printed on stderr: it proves the scrubber catches the forms a server echoes
//   FIXTURE_INSTRUCTIONS  returned as `initialize.instructions`
//   FIXTURE_RENAME=1      `write_note` is listed as `write_note_v2`
//   FIXTURE_ENVFILE       at start, writes {"env":[names...],"cwd":"..."} there (names only, never values)
//   FIXTURE_LOG           appends one JSON line per message the CLIENT answered to a server request (`serverrequests`)

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.env.FIXTURE_MODE || "ok";
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => out({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => out({ jsonrpc: "2.0", id, error: { code, message } });

if (process.env.FIXTURE_ENVFILE) {
  writeFileSync(process.env.FIXTURE_ENVFILE, JSON.stringify({ env: Object.keys(process.env).sort(), cwd: process.cwd() }));
}

if (mode === "exit") {
  process.stderr.write(`fatal: cannot start with token ${process.env.FIXTURE_TOKEN || ""}\n`);
  process.exit(3);
}
if (mode === "stderrenv") {
  for (const [k, v] of Object.entries(process.env)) process.stderr.write(`${k}=${v}\n`);
}
if (mode === "badjson") out_banner();
if (mode === "grandchild") {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  if (process.env.FIXTURE_PIDFILE) writeFileSync(process.env.FIXTURE_PIDFILE, `${process.pid} ${child.pid}`);
} else if (process.env.FIXTURE_PIDFILE) {
  writeFileSync(process.env.FIXTURE_PIDFILE, `${process.pid}`);
}
if (process.env.FIXTURE_ECHO && process.env[process.env.FIXTURE_ECHO]) {
  const v = process.env[process.env.FIXTURE_ECHO];
  const token = v.split(" ").pop();
  const forms = [v, token, encodeURIComponent(v), Buffer.from(v).toString("base64"), JSON.stringify(v).slice(1, -1)];
  if (/^basic /i.test(v)) forms.push(Buffer.from(token, "base64").toString());
  for (const f of forms) process.stderr.write(`echo: ${f}\n`);
}

function out_banner() {
  process.stdout.write("Fixture MCP server v1 ready (this banner belongs on stderr)\n");
}

const annotated = mode !== "noannotations";
const t = (name, description, ro, extra = {}) => ({
  name,
  description,
  inputSchema: { type: "object", properties: extra.properties || {} },
  ...(annotated && ro !== undefined ? { annotations: { readOnlyHint: ro, ...(extra.destructive !== undefined ? { destructiveHint: extra.destructive } : {}) } } : {}),
});
const writeNote = process.env.FIXTURE_RENAME === "1" ? "write_note_v2" : "write_note";
const LONG = "a_very_long_tool_name_that_pushes_the_whole_exposed_name_over_sixty_four_chars";
const tools = [
  t("echo", "Returns its text argument.", true, { properties: { text: { type: "string" } } }),
  t(writeNote, "Writes a note (pretend).", false),
  t("mystery", "No annotations at all.", undefined),
  t("env_has", "True when the named variable exists in this server's environment. Never returns a value.", true, { properties: { name: { type: "string" } } }),
  t("api_key_rotate", "A name that looks secret.", false),
  t("do.thing", "Normalises to do_thing.", false),
  t("dup_", "Collides with dup! after normalisation.", false),
  t("dup!", "Collides with dup_ after normalisation.", false),
  t("env_names", "The NAMES of this server's environment, never values.", true),
  t("read_path", "The byte count of the file at `path`.", true, { properties: { path: { type: "string" } } }),
  t(LONG, "Pushes the exposed name over 64 characters.", true),
  t("git_commit", "Looks like a git write (no tools/call).", false),
  t("delete_file", "Destructive.", false, { destructive: true }),
];
const many = Array.from({ length: 700 }, (_, i) => t(`bulk_tool_${i}`, `Bulk tool ${i}`, i % 2 === 0));

function listTools(params) {
  if (mode !== "many") return { tools };
  const start = Number(params?.cursor || 0);
  const page = many.slice(start, start + 100);
  return start + 100 < many.length ? { tools: page, nextCursor: String(start + 100) } : { tools: page };
}

function callTool(name, args) {
  const text = (s) => ({ content: [{ type: "text", text: String(s) }] });
  switch (name) {
    case "echo": return text(args?.text ?? "");
    case writeNote: return text("noted");
    case "env_has": return text(Object.prototype.hasOwnProperty.call(process.env, String(args?.name)) ? "true" : "false");
    case "env_names": return text(Object.keys(process.env).sort().join(","));
    case "read_path": {
      try { return text(statSync(String(args?.path)).isFile() ? readFileSync(String(args.path)).length : "not a file"); } catch { return text("unreadable"); }
    }
    default: return null;
  }
}

function handle(msg) {
  const { id, method, params } = msg;
  if (id !== undefined && method === undefined) {
    // an answer to a request this server sent
    if (process.env.FIXTURE_LOG) appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ id, result: msg.result ?? null, error: msg.error ?? null }) + "\n");
    return;
  }
  switch (method) {
    case "initialize": {
      const answer = () => reply(id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "fixture", version: "1.0.0" },
        ...(process.env.FIXTURE_INSTRUCTIONS ? { instructions: process.env.FIXTURE_INSTRUCTIONS } : {}),
      });
      if (mode === "hang") return;
      if (mode === "slow") return void setTimeout(answer, 15000);
      if (mode === "serverrequests") {
        out({ jsonrpc: "2.0", id: "s1", method: "ping" });
        out({ jsonrpc: "2.0", id: "s2", method: "roots/list" });
        out({ jsonrpc: "2.0", id: "s3", method: "sampling/createMessage", params: { messages: [] } });
        return void setTimeout(answer, 150);
      }
      if (mode === "big") process.stdout.write("x".repeat(1_500_000) + "\n");
      return answer();
    }
    case "notifications/initialized": return;
    case "ping": return reply(id, {});
    case "tools/list": return reply(id, listTools(params));
    case "tools/call": {
      const r = callTool(params?.name, params?.arguments);
      return r ? reply(id, r) : fail(id, -32601, `tool ${params?.name} cannot be called`);
    }
    case "resources/list": return reply(id, { resources: [{ uri: "fixture://note", name: "note", mimeType: "text/plain" }] });
    case "resources/read": return reply(id, { contents: [{ uri: "fixture://note", mimeType: "text/plain", text: "a fixture note" }] });
    default:
      if (id !== undefined) fail(id, -32601, `method ${method} not found`);
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  try { handle(JSON.parse(line)); } catch (e) { process.stderr.write(`fixture: bad line (${e.message})\n`); }
});
process.stdin.on("end", () => process.exit(0));
