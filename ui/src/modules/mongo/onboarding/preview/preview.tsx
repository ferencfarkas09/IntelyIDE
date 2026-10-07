// Dev-only harness for screenshots: /src/modules/mongo/onboarding/preview/index.html?mongo=on&scene=<name>. Not part of the app build.
import { render } from "solid-js/web";
import { initTheme } from "../../../../theme/theme";
import { localeReady } from "../../../../i18n";
import { ipc } from "../../../../ipc";
import { Toaster } from "../../../../ui-kit";
import type { ImportPreview } from "../../../../ipc/mongo";
import { ConnectionManager } from "../../ConnectionManager";
import { applyStatus, expectClose } from "../../gate";
import SettingsSection from "../../SettingsSection";
import { refreshProfiles } from "../../store";

const q = new URLSearchParams(location.search);
const scene = q.get("scene") ?? "manager";
if (q.get("dir")) document.documentElement.dir = q.get("dir")!;

const act = async (fn: () => void | Promise<void>, ms = 150) => { await new Promise((r) => setTimeout(r, ms)); await fn(); };
const click = (re: RegExp, root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>("button, [role=radio], [role=menuitem]")].find((b) => re.test(b.textContent ?? "") || re.test(b.getAttribute("aria-label") ?? ""))?.click();
const setValue = (el: HTMLInputElement, v: string) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
const cardOf = (name: string) => document.querySelector<HTMLElement>(`article[aria-label="${name}"]`)!;

const FILE: ImportPreview = {
  items: [
    { name: "Acme via bastion", warnings: [], endpoints: ["db1.internal:27017", "db2.internal:27017", "bastion.acme.example:22"], needsConfirm: true },
    { name: "Staging replica set", warnings: [{ code: "relativePath", option: "tlsCAFile" }], endpoints: ["rs1.staging.example:27017", "rs2.staging.example:27017"], needsConfirm: true },
    { name: "Local dev", warnings: [], endpoints: [], needsConfirm: false },
  ],
  notes: [],
};

async function main() {
  initTheme();
  await localeReady;
  if (scene === "first" || scene === "first-found" || scene === "wizard-pick" || scene === "wizard-atlas" || scene === "wizard-ssh" || scene === "wizard-local" || scene === "wizard-review" || scene === "wizard-done" || scene === "import-empty") {
    for (const p of await ipc.mongo.profiles()) await ipc.mongo.profileDelete(p.id);
  }
  if (scene === "wizard-pick") await ipc.settings.set("mongo", { onboardingDone: true } as never);
  applyStatus(await ipc.mongo.status());
  await refreshProfiles();

  const root = document.getElementById("root")!;
  const settings = scene === "settings" || scene === "reset";
  render(() => (
    <>
      <section class="mg-page" aria-label="MongoDB connections" style={{ "max-width": settings ? "720px" : undefined, margin: settings ? "0 auto" : undefined }}>
        {settings ? <SettingsSection /> : <ConnectionManager defaultAi="off" />}
      </section>
      <Toaster />
    </>
  ), root);

  if (scene === "first-found") await act(() => { click(/Look for MongoDB/); }, 300);
  if (scene === "first-found") await act(() => undefined, 600);
  if (scene === "wizard-pick") await act(() => { click(/Connection guide|Kapcsolat var/); }, 300);
  if (scene === "wizard-atlas" || scene === "wizard-ssh" || scene === "wizard-local" || scene === "wizard-review" || scene === "wizard-done") {
    await act(() => { click(/^(Start|Kezdés)$/, document.querySelectorAll(".mm-tile")[scene === "wizard-atlas" ? 0 : scene === "wizard-local" ? 1 : scene === "wizard-ssh" ? 3 : 1]); }, 300);
  }
  if (scene === "wizard-atlas") await act(() => { const box = document.getElementById("mgf-uri-input") as HTMLInputElement | null; if (box) { setValue(box, "mongodb+srv://reader:<password>@cluster0.k3x9q.mongodb.net/shop?retryWrites=true"); click(/Fill the form|Űrlap kitöltése/); } }, 400);
  if (scene === "wizard-review" || scene === "wizard-done") {
    await act(() => click(/^(Next|Tovább)$/), 400);
    if (scene === "wizard-done") await act(() => click(/^(Save|Mentés)$/), 300);
    else await act(() => click(/Test connection|Kapcsolat tesztelése/), 300);
    await new Promise((r) => setTimeout(r, 1800));
  }
  if (scene === "prod-endpoints" || scene === "prod-confirm") {
    await act(() => click(/^(Connect|Csatlakozás)$/, cardOf("Acme production")), 300);
    if (scene === "prod-confirm") await act(() => click(/^(Connect|Csatlakozás)$/, document.querySelector("[role=alertdialog]")!), 300);
  }
  if (scene === "password") {
    await ipc.mongo.profileSave({ name: "Reporting replica", environment: "local", spec: { scheme: "standard", hosts: [{ host: "127.0.0.1", port: 27017 }], auth: { mechanism: "default", username: "reader", source: "admin", savePassword: false }, tls: { mode: "auto" }, tunnel: { kind: "none" } } } as never);
    await refreshProfiles();
    await act(() => click(/^(Connect|Csatlakozás)$/, cardOf("Reporting replica")), 400);
  }
  if (scene === "connected") {
    await act(() => click(/^(Connect|Csatlakozás)$/, cardOf("Local fixture")), 300);
    await act(() => click(/^(Connect|Csatlakozás)$/, cardOf("Happy fixture")), 500);
    await new Promise((r) => setTimeout(r, 1200));
  }
  if (scene === "lost") {
    await act(() => click(/^(Connect|Csatlakozás)$/, cardOf("Local fixture")), 300);
    await new Promise((r) => setTimeout(r, 1200));
    // The gateway drops the connection without the user asking (tunnel died, sleep): simulate the state event.
    const s = await ipc.mongo.status();
    applyStatus({ ...s, connections: s.connections.filter((c) => c.id !== "local-fixture") });
  }
  if (scene === "import" || scene === "import-empty") {
    ipc.mongo.dialogOpen = async () => ({ token: "h1", kind: "import", fileName: "acme-team.json" });
    ipc.mongo.profilesImportPreview = async () => FILE;
    await act(() => click(/^Import…|^Importálás…/), 300);
    await new Promise((r) => setTimeout(r, 500));
  }
  if (scene === "export") await act(() => click(/^Export…|^Exportálás…/), 300);
  if (scene === "move") { await act(() => click(/^(More|Több)$/, cardOf("Local fixture")), 300); await act(() => click(/Move to group|csoportba/), 300); }
  if (scene === "delete") { await act(() => click(/^(More|Több)$/, cardOf("Local fixture")), 300); await act(() => click(/Delete|Törlés/), 300); }
  if (scene === "reset") await act(() => click(/^Reset…|^Alaphelyzet…/), 300);
  void expectClose;
  document.documentElement.dataset.ready = "1";
}
void main();
