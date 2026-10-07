// Dev-only harness for screenshots: /src/modules/mongo/form/preview/index.html?mongo=on&scene=<name>&tab=<tab>. Not part of the app build.
import { render } from "solid-js/web";
import { initTheme } from "../../../../theme/theme";
import { localeReady } from "../../../../i18n";
import { ipc } from "../../../../ipc";
import { Toaster } from "../../../../ui-kit";
import type { ConnSpec } from "../../../../ipc/mongo";
import { ConnectionForm } from "../../ConnectionForm";
import { refreshProfiles } from "../../store";
import type { FormTab } from "../model";

const q = new URLSearchParams(location.search);
const scene = q.get("scene") ?? "new";
const tab = (q.get("tab") ?? undefined) as FormTab | undefined;
if (q.get("dir")) document.documentElement.dir = q.get("dir")!;

const atlas: ConnSpec = { scheme: "srv", hosts: [{ host: "cluster0.k3x9q.mongodb.net" }], database: "shop", auth: { mechanism: "default", username: "reader", source: "admin", savePassword: true }, tls: { mode: "auto" }, tunnel: { kind: "none" } };
const replica: ConnSpec = { scheme: "standard", hosts: [{ host: "rs1.acme.example", port: 27017 }, { host: "rs2.acme.example", port: 27017 }, { host: "rs3.acme.example", port: 27017 }], auth: { mechanism: "scramSha256", username: "reader", source: "admin", savePassword: true }, tls: { mode: "on", caFile: "/Users/me/certs/acme-ca.pem" }, topology: { replicaSet: "rs0", readPreference: "secondaryPreferred", maxStalenessS: 120 }, compressors: ["zlib", "snappy"], tunnel: { kind: "none" } };
const ssh = (host = "bastion.acme.example"): ConnSpec => ({ scheme: "standard", hosts: [{ host: "db1.internal", port: 27017 }], auth: { mechanism: "default", username: "reader", savePassword: true }, tls: { mode: "auto" }, tunnel: { kind: "ssh", host, user: "deploy", auth: "keyFile", keyFile: "/Users/me/.ssh/id_ed25519", saveSecret: true, useSshConfig: true, allowedHosts: [{ host: "db1.internal", port: 27017 }, { host: "db2.internal", port: 27017 }] } });
const local: ConnSpec = { scheme: "standard", hosts: [{ host: "127.0.0.1", port: 27017 }], auth: { mechanism: "none" }, tls: { mode: "auto" }, tunnel: { kind: "none" } };

const pick = (): { spec?: ConnSpec; tab?: FormTab; name?: string } => {
  switch (scene) {
    case "atlas": return { spec: atlas, name: "Shop (Atlas)" };
    case "replica": return { spec: replica, name: "Acme replica set" };
    case "ssh-test": return { spec: { ...ssh("inject-tunnel-notallowed.acme.example"), auth: { mechanism: "none" }, tunnel: { kind: "ssh", host: "inject-tunnel-notallowed.acme.example", user: "deploy", auth: "agent", useSshConfig: true, allowedHosts: [{ host: "db1.internal", port: 27017 }] } }, name: "Acme via bastion" };
    case "ssh": case "hostkey": return { spec: ssh(scene === "hostkey" ? "inject-tunnel-hostkeyunknown.acme.example" : undefined), name: "Acme via bastion" };
    case "ok": case "local": return { spec: local, name: "Local fixture" };
    case "plain": return { spec: { ...atlas, scheme: "standard", hosts: [{ host: "db.acme.example", port: 27017 }], auth: { mechanism: "plain", username: "u" }, tls: { mode: "off" } }, name: "" };
    case "fail": return { spec: { ...atlas, auth: { mechanism: "none" }, hosts: [{ host: "inject-tls-hostname.acme.example" }] }, name: "Bad certificate" };
    case "timeout": return { spec: { ...atlas, auth: { mechanism: "none" }, hosts: [{ host: "inject-net-timeout.k3x9q.mongodb.net" }] }, name: "Atlas timeout" };
    default: return {};
  }
};

const act = async (fn: () => void | Promise<void>, ms = 120) => { await new Promise((r) => setTimeout(r, ms)); await fn(); };
const setValue = (el: HTMLInputElement, v: string) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
const clickBtn = (re: RegExp) => [...document.querySelectorAll<HTMLElement>("button")].find((b) => re.test(b.textContent ?? "") || re.test(b.getAttribute("aria-label") ?? ""))?.click();
const clickTab = (name: string) => document.getElementById(`mgf-tab-${name}`)?.click();

async function main() {
  initTheme();
  await localeReady;
  await refreshProfiles();
  const p = pick();
  const profiles = await ipc.mongo.profiles();
  const withProfile = scene === "edit" ? profiles.find((x) => x.id === "production") : undefined;
  render(() => (
    <>
      <ConnectionForm profile={withProfile} defaultAi="off" happyPreset={scene === "ai"} initial={p.spec ? { spec: p.spec, name: p.name } : undefined} tab={tab ?? p.tab} onClose={() => undefined} />
      <Toaster />
    </>
  ), document.getElementById("root")!);

  if (scene === "string") {
    await act(() => void [...document.querySelectorAll<HTMLElement>("[role=radio]")].find((r) => /string|szöveg/i.test(r.textContent ?? ""))?.click());
    await act(() => {
      const box = document.getElementById("mgf-uri-input") as HTMLInputElement;
      setValue(box, "mongodb+srv://reader:S3cr%40t@cluster0.k3x9q.mongodb.net/shop?retryWrites=true&w=majority&authMechanism=MONGODB-AWS&proxyHost=p.example.com");
      clickBtn(/Fill the form|Űrlap kitöltése/);
    }, 250);
  }
  if (scene === "errors") {
    await act(() => clickBtn(/^(Save|Mentés)$/), 300);
  }
  if (scene === "ok" || scene === "fail" || scene === "timeout" || scene === "ssh-test") {
    await act(() => { const n = document.getElementById("mgf-name") as HTMLInputElement; if (!n.value) setValue(n, "Shop"); clickBtn(/^(Test connection|Kapcsolat tesztelése)$/); }, 250);
    await new Promise((r) => setTimeout(r, 1800));
  }
  if (scene === "hostkey") {
    clickTab("tunnel");
    await act(() => clickBtn(/Check host key|Gazdakulcs ellenőrzése/), 250);
  }
  if (scene === "confirm") {
    clickTab("ai");
    await act(() => [...document.querySelectorAll<HTMLElement>('[role=radio]')].find((r) => /P1 ·/.test(r.textContent ?? ""))?.click());
  }
  document.documentElement.dataset.ready = "1";
}
void main();
