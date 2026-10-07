#!/usr/bin/env node
// A user-level SSH server that checks a PASSWORD and a keyboard-interactive answer, for the matrix part that a non-root
// OpenSSH sshd cannot serve (no PAM and no shadow file without root, so `sshd` as the current user has no password to check).
// Real SSH protocol, real `ssh` client on the other side: it proves the app's askpass flow (password and keyboard-interactive),
// the wrong-password diagnosis and `ssh -W` streams through the master. It is NOT OpenSSH's sshd: say so wherever its result is used.
//
//   INTELY_SSHPW=<password> node ssh-password-server.mjs --port N --host-key <file> --user <name> [--ssh2-dir <node_modules dir>]
//
// Prints one JSON line {"ready":true,"port":N,"ssh2":"<version>"} on stdout when it listens, and exits on SIGTERM.
// Safety: binds 127.0.0.1 only; the password comes from the environment (never argv); direct-tcpip forwards are allowed only to
// loopback targets; shells, exec, subsystems and every other request are refused; nothing is written to disk.
//
// The `ssh2` module is not a dependency of this project: it is looked up in --ssh2-dir, $INTELY_MLOCAL_SSH2_DIR, then the usual
// node_modules folders of the repository. When none has it the script exits with code 3 and the matrix reports the part as skipped.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const port = Number(args.get("port"));
const hostKey = args.get("host-key");
const user = args.get("user");
const password = process.env.INTELY_SSHPW;
if (!port || !hostKey || !user || !password) {
  console.error("usage: INTELY_SSHPW=... ssh-password-server.mjs --port N --host-key FILE --user NAME [--ssh2-dir DIR]");
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dirs = [args.get("ssh2-dir"), process.env.INTELY_MLOCAL_SSH2_DIR, path.join(root, "node_modules"), path.join(root, "ui/node_modules"), path.join(root, "sidecar/node_modules")].filter(Boolean);
let ssh2;
let version = "?";
for (const dir of dirs) {
  try {
    const req = createRequire(path.join(path.resolve(dir), "noop.js"));
    ssh2 = req("ssh2");
    version = req("ssh2/package.json").version;
    break;
  } catch {
    /* try the next folder */
  }
}
if (!ssh2) {
  console.error("ssh2 module not found (set INTELY_MLOCAL_SSH2_DIR to a node_modules folder that has it)");
  process.exit(3);
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const METHODS = ["password", "keyboard-interactive"];
const live = new Set();

const server = new ssh2.Server({ hostKeys: [readFileSync(hostKey)] }, (client) => {
  live.add(client);
  client.on("close", () => live.delete(client));
  client.on("error", () => {});
  client.on("authentication", (ctx) => {
    if (ctx.username !== user) return ctx.reject(METHODS);
    if (ctx.method === "password") return ctx.password === password ? ctx.accept() : ctx.reject(METHODS);
    if (ctx.method === "keyboard-interactive") {
      return ctx.prompt([{ prompt: "Password: ", echo: false }], "", "", (answers) => (answers.length === 1 && answers[0] === password ? ctx.accept() : ctx.reject(METHODS)));
    }
    return ctx.reject(METHODS); // `none`, publickey: tell the client what is left
  });
  client.on("ready", () => {
    // `ssh -W host:port` (stdio forwarding) and `-L` both arrive as direct-tcpip channels
    client.on("tcpip", (accept, reject, info) => {
      if (!LOOPBACK.has(info.destIP)) return reject();
      const out = net.connect(info.destPort, info.destIP === "localhost" ? "127.0.0.1" : info.destIP);
      out.once("connect", () => {
        const ch = accept();
        ch.pipe(out).pipe(ch);
        const end = () => (ch.destroy(), out.destroy());
        ch.on("error", end).on("close", end);
        out.on("error", end).on("close", end);
      });
      out.once("error", () => reject());
    });
    client.on("session", (accept, reject) => reject());
    client.on("request", (accept, reject) => reject()); // tcpip-forward, no-more-sessions@..., hostkeys-prove...
  });
});

server.on("error", (e) => {
  console.error(`ssh-password-server: ${e.message}`);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ ready: true, port, ssh2: version })));

const stop = () => {
  for (const c of live) c.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
