// Dev-only harness for screenshots: /src/modules/mongo/stepper/preview/index.html?scene=<name>. Not part of the app build.
import { Match, Switch } from "solid-js";
import { render } from "solid-js/web";
import { initTheme } from "../../../../theme/theme";
import type { Diagnosis, HostKeyView, TestReport, TestStep } from "../../../../ipc/mongo";
import { AllowHostsDialog, DiagnosisView, HostKeyDialog, TestStepper } from "../index";

const s = (id: TestStep["id"], state: TestStep["state"], ms = 0): TestStep => ({ id, state, ms });
const view = (status: HostKeyView["status"]): HostKeyView => ({ host: "bastion.example.com", port: 22, keyType: "ssh-ed25519", fingerprint: "SHA256:4v0cK2n7oQ1xLw9B3s8TjYd5HfA6eRmUpZgNiVtXb0E", status });
const diag = (code: string, class_: Diagnosis["class"], params: Diagnosis["params"] = [], retryable = false): Diagnosis => ({ class: class_, code, params, detail: "server selection error: Kind: No available servers, Server: db1.example.com:27017 { Error: received fatal alert: BadCertificate }", retryable });
const ok: TestReport = {
  ok: true, elapsedMs: 1840, warnings: ["config.plainRemote", "roleElevated"], members: ["rs1.internal:27017", "rs2.internal:27017", "rs3.internal:27017"],
  connection: { id: "a", name: "Acme", serverVersion: "7.0.5", topology: "replicaSet", pingMs: 14, effectiveLevel: "productionLevel", environment: "production", readOnly: true, readPreference: "primaryPreferred", role: { role: "canWrite" }, roleElevated: true, tls: false, tlsRelax: "none" },
} as unknown as TestReport;
const noop = () => {};
const scene = new URLSearchParams(location.search).get("scene") ?? "running";

function App() {
  return (
    <div style={{ "max-inline-size": "560px", margin: "24px auto", padding: "0 16px", display: "flex", "flex-direction": "column", gap: "16px", background: "var(--surface-1)" }}>
      <Switch>
        <Match when={scene === "running"}>
          <TestStepper tunnel running onCancel={noop} steps={[s("config", "ok", 3), s("tunnel", "ok", 640), s("connect", "running")]} />
        </Match>
        <Match when={scene === "failed"}>
          <TestStepper tunnel={false} running={false} report={{ ok: false, elapsedMs: 900 }} steps={[s("config", "ok", 2), s("dns", "ok", 31), s("connect", "ok", 40), s("tls", "failed", 120)]}>
            <DiagnosisView failedStep="Secure connection" diagnosis={diag("tls.hostname", "tls", [["host", "db1.example.com"]])} onRetry={noop} />
          </TestStepper>
        </Match>
        <Match when={scene === "atlas"}>
          <TestStepper tunnel={false} running={false} report={{ ok: false, elapsedMs: 10100 }} steps={[s("config", "ok", 2), s("dns", "ok", 80), s("connect", "failed", 10000)]}>
            <DiagnosisView failedStep="Connect" diagnosis={diag("net.timeout", "network", [["hint", "atlas.networkAccess"]], true)} onRetry={noop} />
          </TestStepper>
        </Match>
        <Match when={scene === "notallowed"}>
          <TestStepper tunnel running={false} report={{ ok: false, elapsedMs: 700 }} steps={[s("config", "ok", 2), s("tunnel", "failed", 650)]}>
            <DiagnosisView failedStep="SSH tunnel" diagnosis={diag("tunnel.notAllowed", "tunnel", [["host", "rs2.internal:27018"]])} onAllowHost={noop} />
          </TestStepper>
        </Match>
        <Match when={scene === "ok"}>
          <TestStepper tunnel={false} running={false} report={ok} unallowedMembers={ok.members} onAllowMembers={noop} steps={["config", "dns", "connect", "tls", "auth", "permissions"].map((id, i) => s(id as TestStep["id"], i === 5 ? "warn" : "ok", 20 + i * 30))} />
        </Match>
        <Match when={scene === "authz"}>
          <DiagnosisView failedStep="Permissions" diagnosis={diag("authz.listDatabases", "authz")} />
        </Match>
        <Match when={scene === "hostkey-unknown"}>
          <HostKeyDialog open view={view("unknown")} onTrust={noop} onForget={noop} onClose={noop} />
        </Match>
        <Match when={scene === "hostkey-changed"}>
          <HostKeyDialog open view={view("changed")} expectedFingerprint="SHA256:Zk1qP8mC0dWvY3nT7bLxH2sRfA9eUoJgIiNt5XcQ4Eg" onTrust={noop} onForget={noop} onClose={noop} />
        </Match>
        <Match when={scene === "hostkey-unscannable"}>
          <HostKeyDialog open unscannable host="bastion.example.com" onTrust={noop} onForget={noop} onClose={noop} />
        </Match>
        <Match when={scene === "allow-one"}>
          <AllowHostsDialog open hosts={["rs2.internal:27018"]} onConfirm={noop} onClose={noop} />
        </Match>
        <Match when={scene === "allow-many"}>
          <AllowHostsDialog open hosts={["rs1.internal:27017", "rs2.internal:27017", "169.254.169.254:80"]} onConfirm={noop} onClose={noop} />
        </Match>
      </Switch>
    </div>
  );
}

initTheme();
render(() => <App />, document.getElementById("root")!);
