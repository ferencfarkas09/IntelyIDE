#!/usr/bin/env node
// A fixture MCP server over Streamable HTTP for tests ((design notes: mcp-management-spec) 9.1). Listens on 127.0.0.1 only and prints
// `listening <port>` on stdout. No dependencies.
//
//   node mcp-fixture-http.mjs [--port N]
//
// FIXTURE_MODE: ok (default: JSON replies, `Mcp-Session-Id` issued, DELETE accepted) | sse (replies as text/event-stream) |
//   needsauth (401 unless `Authorization: Bearer <FIXTURE_TOKEN>`) | oauth (like needsauth, with a WWW-Authenticate challenge) |
//   redirect (302 to another path of this server) | status500
// FIXTURE_LOG: appends one JSON line per request: {method, path, headers: [names only]}. Values are never recorded.

import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const mode = process.env.FIXTURE_MODE || "ok";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]) || 0;
const SESSION = "fixture-session-1";

const tools = [
  { name: "echo", description: "Returns its text argument.", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "write_note", description: "Writes a note (pretend).", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
];

function answer(msg) {
  switch (msg.method) {
    case "initialize":
      return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture-http", version: "1.0.0" } };
    case "tools/list": return { tools };
    case "ping": return {};
    default: return undefined;
  }
}

const server = createServer((req, res) => {
  if (process.env.FIXTURE_LOG) {
    appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ method: req.method, path: req.url, headers: Object.keys(req.headers).sort() }) + "\n");
  }
  if (mode === "status500") { res.writeHead(500).end("boom"); return; }
  if (mode === "redirect") {
    if (req.url !== "/elsewhere") { res.writeHead(302, { Location: "/elsewhere" }).end(); return; }
    res.writeHead(200).end("{}");
    return;
  }
  if ((mode === "needsauth" || mode === "oauth") && req.headers.authorization !== `Bearer ${process.env.FIXTURE_TOKEN}`) {
    res.writeHead(401, mode === "oauth" ? { "WWW-Authenticate": 'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"' } : {}).end("unauthorized");
    return;
  }
  if (req.method === "DELETE") { res.writeHead(200).end(); return; }
  if (req.method !== "POST") { res.writeHead(405).end(); return; }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let msg;
    try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
    if (msg.id === undefined) { res.writeHead(202).end(); return; }
    const result = answer(msg);
    const payload = result === undefined ? { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } } : { jsonrpc: "2.0", id: msg.id, result };
    const headers = msg.method === "initialize" ? { "Mcp-Session-Id": SESSION } : {};
    if (mode === "sse") {
      res.writeHead(200, { "Content-Type": "text/event-stream", ...headers });
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } })}\n\n`);
      res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    } else {
      res.writeHead(200, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`listening ${server.address().port}\n`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
