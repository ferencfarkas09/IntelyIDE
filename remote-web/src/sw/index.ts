// IntelyIDE Remote service worker (built to dist/sw.js by vite.sw.config.ts). Three jobs and nothing else:
//  1. a verified offline shell: builds are downloaded and checked (signature against the pinned key, seq, file hashes) by sw/core.ts
//     and served cache-first; there is NO install-time download (a byte-identical worker never re-runs install), updates are
//     message driven: the page sends `check` at start and every 6 hours;
//  2. offline start from that shell; the relay (/r/, /api/) and /bundle.json are never cached;
//  3. content-free Web Push: the notification text comes from a fixed table keyed by the payload's `kind`, never from the payload.
import { pinKv } from "../core/pin";
import { createShell, type ToPage, type ToWorker } from "./core";

// Only the pieces of the worker scope used here (the project compiles with both DOM and WebWorker libs).
interface Scope {
  location: Location;
  registration: { showNotification(title: string, o?: NotificationOptions): Promise<void> };
  clients: { claim(): Promise<void>; matchAll(o: { type: "window"; includeUncontrolled: boolean }): Promise<{ postMessage(m: unknown): void; focus(): Promise<unknown> }[]>; openWindow(url: string): Promise<unknown> };
  skipWaiting(): Promise<void>;
  addEventListener(type: string, fn: (e: never) => void): void;
}
const sw = self as unknown as Scope;

const clientsOf = () => sw.clients.matchAll({ type: "window", includeUncontrolled: true });

const shell = createShell({
  caches,
  fetch: (input, init) => fetch(input, init),
  kv: pinKv(),
  origin: sw.location.origin,
  post: async (msg: ToPage) => {
    for (const c of await clientsOf()) c.postMessage(msg);
  },
});

type Ev = { waitUntil(p: Promise<unknown>): void };

sw.addEventListener("install", ((event: Ev) => {
  event.waitUntil(sw.skipWaiting());
}) as (e: never) => void);

sw.addEventListener("activate", ((event: Ev) => {
  event.waitUntil(sw.clients.claim());
}) as (e: never) => void);

sw.addEventListener("message", ((event: Ev & { data: ToWorker }) => {
  switch (event.data?.type) {
    case "check":
      return event.waitUntil(shell.check());
    case "pin-updated":
      return event.waitUntil(shell.pinUpdated());
    case "activate":
      return event.waitUntil(shell.activate());
    case "status":
      return event.waitUntil(shell.status());
    default:
      return;
  }
}) as (e: never) => void);

sw.addEventListener("fetch", ((event: Ev & { request: Request; respondWith(p: Promise<Response>): void }) => {
  if (!shell.handles(event.request)) return;
  event.respondWith(shell.respond(event.request));
}) as (e: never) => void);

const TEXT: Record<string, string> = {
  needsYou: "Needs you",
  finished: "A run finished",
  failed: "A run failed",
  brief: "Your morning brief is ready",
};

sw.addEventListener("push", ((event: Ev & { data?: { json(): { kind?: string } } }) => {
  let kind = "needsYou";
  try {
    const k = event.data?.json()?.kind;
    if (typeof k === "string" && Object.prototype.hasOwnProperty.call(TEXT, k)) kind = k;
  } catch {
    /* content-free: an empty or odd payload is the "needs you" default */
  }
  event.waitUntil(sw.registration.showNotification("IntelyIDE", { body: TEXT[kind], tag: kind, data: { kind } }));
}) as (e: never) => void);

sw.addEventListener("notificationclick", ((event: Ev & { notification: { close(): void } }) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const all = await clientsOf();
      if (all.length) return all[0]!.focus();
      return sw.clients.openWindow("/#/");
    })(),
  );
}) as (e: never) => void);
