import { resourceDir } from "@tauri-apps/api/path";
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { t, type MessageKey } from "../../i18n";
import { ipc } from "../../ipc";
import type { ProviderInfo } from "../../ipc/providers";
import { vibeIpc, type SetupCheck } from "../../ipc/vibe";
import { errorText } from "../../store/snapshots";
import { Badge, Button, Copy, EmptyState, RefreshCw, Skeleton, SquareTerminal, StatusDot, toast, Wrench, type Tone } from "../../ui-kit";
import { DEFAULT_RESOURCES_DIR, sdkSetupCommands } from "../providers/logic";
import { doctorRows, fixOf, platform, summary, type DoctorRow } from "./logic";
import "./doctor.css";

const TONE: Record<DoctorRow["status"], Tone> = { ok: "ok", warn: "warn", missing: "danger", notChecked: "neutral" };

/** The status sentence of a row: its reason when it has one, else its status. */
export function statusText(r: DoctorRow): string {
  if (r.reason) return t(`setup.reason.${r.reason}` as MessageKey, { version: r.version ?? "" });
  if (r.status === "ok") return r.version ? t("setup.state.okVersion", { version: r.version }) : t("setup.state.ok");
  return t(`setup.state.${r.status}` as MessageKey);
}

/**
 * Types the command into a new terminal tab without pressing Return: the person reads it and runs it. The tab opens in the
 * home folder, never in a repository, so a repository's own settings or hooks cannot ride along (`claude` reads them).
 */
export async function putInTerminal(command: string): Promise<void> {
  try {
    const term = await import("../terminal/store");
    const id = await term.openTerminal({});
    if (!id) return;
    await ipc.term.write(id, command);
    toast.info(t("setup.typed"), t("setup.typedBody"));
  } catch (e) {
    toast.error(t("setup.typeFailed"), errorText(e));
  }
}

/** Reads the probes and Claude's provider state. Exported for the first-run card. */
export async function runDoctor(): Promise<DoctorRow[]> {
  const [probes, providers] = await Promise.all([vibeIpc().setupChecks().catch((): SetupCheck[] => []), ipc.providers.detect().catch(() => ipc.providers.list()).catch((): ProviderInfo[] => [])]);
  return doctorRows(probes, providers.find((p) => p.id === "claude"));
}

/** Setup doctor: is everything an agent run and the usual mobile and web stacks need installed? Only looks; changes nothing. */
export default function DoctorTab() {
  const [rows, setRows] = createSignal<DoctorRow[] | undefined>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>();
  const [resources, setResources] = createSignal(DEFAULT_RESOURCES_DIR);
  const on = platform();
  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setRows(await runDoctor());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  onMount(() => {
    void resourceDir().then((dir) => dir && setResources(dir), () => undefined);
    void run();
  });
  const counts = createMemo(() => (rows() ? summary(rows()!) : undefined));
  const copy = (text: string) => void navigator.clipboard?.writeText(text).then(() => toast.info(t("setup.copied")), () => undefined);

  return (
    <div class="setupdoc">
      <div class="setupdoc__bar">
        <h2 class="setupdoc__title">{t("setup.title")}</h2>
        <Show when={counts()}>
          {(c) => (
            <Badge tone={c().blocking ? "danger" : c().optional ? "warn" : "ok"} size="sm">
              {c().blocking ? t("setup.summary.blocking", { count: c().blocking }) : c().optional ? t("setup.summary.optional", { count: c().optional }) : t("setup.summary.ok")}
            </Badge>
          )}
        </Show>
        <span class="setupdoc__spacer" />
        <Button size="sm" variant="secondary" icon={RefreshCw} loading={busy()} onClick={() => void run()}>{t("setup.recheck")}</Button>
      </div>
      <p class="setupdoc__lead">{t("setup.lead")}</p>
      <Show when={error()}>{(m) => <EmptyState size="sm" tone="danger" title={t("setup.failed")} description={m()} />}</Show>
      <Show when={rows()} fallback={<Skeleton height={240} />}>
        <ul class="setupdoc__list">
          <For each={rows()}>
            {(r) => {
              const fix = () => fixOf(r, on, sdkSetupCommands(resources()));
              return (
                <li class="setupdoc__row" data-status={r.status} data-check={r.id}>
                  <StatusDot tone={TONE[r.status]} label={t(`setup.state.${r.status}` as MessageKey)} />
                  <div class="setupdoc__main">
                    <div class="setupdoc__head">
                      <span class="setupdoc__name">{t(`setup.name.${r.id}` as MessageKey)}</span>
                      <Show when={r.optional}><Badge size="sm">{t("setup.optional")}</Badge></Show>
                      <span class="setupdoc__status">{statusText(r)}</span>
                    </div>
                    <p class="setupdoc__why">{t(`setup.why.${r.id}` as MessageKey)}</p>
                    <Show when={r.path && r.status !== "ok"}>
                      <p class="setupdoc__path ui-mono">{r.path}</p>
                    </Show>
                    <Show when={fix()?.command}>
                      {(cmd) => (
                        <div class="setupdoc__fix">
                          <pre class="setupdoc__cmd" dir="ltr" tabIndex={0} aria-label={t("setup.fixAria")}>{cmd()}</pre>
                          <div class="setupdoc__actions">
                            <Button size="sm" variant="ghost" icon={Copy} onClick={() => copy(cmd())}>{t("setup.copy")}</Button>
                            <Show when={fix()?.runnable}>
                              <Button size="sm" variant="secondary" icon={SquareTerminal} onClick={() => void putInTerminal(cmd())} title={t("setup.terminalTip")}>{t("setup.terminal")}</Button>
                            </Show>
                          </div>
                        </div>
                      )}
                    </Show>
                    <Show when={!fix()?.command && r.status !== "ok" && r.status !== "notChecked"}>
                      <p class="setupdoc__how"><Wrench size={12} /> {t(`setup.how.${r.id}` as MessageKey)}</p>
                    </Show>
                  </div>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
      <p class="setupdoc__foot">{t("setup.foot")}</p>
    </div>
  );
}
