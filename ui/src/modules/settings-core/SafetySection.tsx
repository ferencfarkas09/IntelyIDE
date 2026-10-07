import { createResource, createSignal, For, lazy, Show, Suspense } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { errorText } from "../../store/snapshots";
import { repos, saveWorkspace, workspace } from "../../store/workspace";
import { Badge, Button, FormGroup, FormRow, Info, ShieldCheck, Switch, toast, type Tone } from "../../ui-kit";
import type { SafetyStatus } from "../../ipc/settings";
import type { Workspace } from "../../ipc";
import { PatternChips, PatternEditor } from "./PatternEditor";
import { setLive, setProtected, effectiveLive } from "./patterns";
import "./settings-core.css";

/** The per-provider "allow weak writer" override lives with the providers module and loads only while Experimental providers is on. */
const WeakWriterControls = lazy(() => import("../providers/WeakWriterControls"));

/** Getters, so the labels follow the language. */
export const JAIL_TEXT: Record<SafetyStatus["jail"], { tone: Tone; label: string; detail: string }> = {
  off: { tone: "ok", get label() { return t("safety.jail.off.label"); }, get detail() { return t("safety.jail.off.detail"); } },
  readOnly: { tone: "warn", get label() { return t("safety.jail.readOnly.label"); }, get detail() { return t("safety.jail.readOnly.detail"); } },
  e2e: { tone: "info", get label() { return t("safety.jail.e2e.label"); }, get detail() { return t("safety.jail.e2e.detail"); } },
};

async function save(change: (ws: Workspace) => Workspace) {
  const ws = workspace();
  if (!ws) return;
  try {
    await saveWorkspace(change(ws));
  } catch (e) {
    toast.error(t("safety.branchRulesFailed"), errorText(e));
  }
}

export default function SafetySection() {
  const [status] = createResource<SafetyStatus | null>(() => ipc.settings.safetyStatus().catch(() => null));
  const safety = () => status() ?? undefined;
  const jail = () => (safety() ? JAIL_TEXT[safety()!.jail] : undefined);
  const [secrets, { refetch: refetchSecrets }] = createResource(() => ipc.secrets.status().catch(() => null));
  const retryKeychain = () => ipc.secrets.retryKeychain().then(() => refetchSecrets(), (e) => toast.error(t("secretstore.retryFailed"), errorText(e)));
  // "Allow processes": the Run panel's session switch (in memory in the backend, off at every launch).
  const [processes, setProcesses] = createSignal(false);
  void ipc.run.access().then((a) => setProcesses(a.allowed), () => {});
  // Zero cost off: without Experimental providers nothing of the override is fetched or rendered.
  const [experimental] = createResource(() => ipc.providers.experimental().catch(() => false));
  const allowProcesses = (next: boolean) => ipc.run.allowProcesses(next).then((a) => setProcesses(a.allowed), (e) => toast.error(t("safety.settingFailed"), errorText(e)));

  return (
    <div class="sc-section">
      <FormGroup title={t("safety.protectionTitle")} description={t("safety.protectionDesc")}>
        <FormRow label={t("safety.mode")} description={jail()?.detail ?? (status.loading ? t("safety.checking") : t("safety.noMode"))}>
          <Show when={jail()} fallback={<Badge tone="neutral" icon={Info}>{status.loading ? t("safety.checkingBadge") : t("safety.unknown")}</Badge>}>
            {(j) => <Badge tone={j().tone} icon={ShieldCheck}>{j().label}</Badge>}
          </Show>
        </FormRow>
        <Show when={safety()?.jail === "e2e" && safety()?.fixtureRoot}>
          <FormRow label={t("safety.fixture")}><code class="sc-code">{safety()?.fixtureRoot}</code></FormRow>
        </Show>
        <FormRow label={t("safety.liveRow")} description={t("safety.liveRowDesc")} />
        <Show when={secrets()}>
          {(s) => (
            <FormRow
              label={t("secretstore.label")}
              description={s().degraded ? (s().message ?? t("secretstore.degraded")) : s().backend === "keychain" ? t("secretstore.keychainDesc") : t("secretstore.memoryDesc")}
            >
              <Badge tone={s().degraded ? "warn" : "neutral"} icon={ShieldCheck}>{s().backend === "keychain" ? t("secretstore.keychain") : t("secretstore.memory")}</Badge>
              <Show when={s().degraded}>
                <Button size="sm" variant="secondary" onClick={() => void retryKeychain()}>{t("secretstore.retry")}</Button>
              </Show>
            </FormRow>
          )}
        </Show>
      </FormGroup>

      <FormGroup title={t("safety.devTitle")} description={t("safety.devDesc")}>
        <FormRow
          label={t("safety.processes")}
          description={
            safety()?.jail === "readOnly"
              ? t("safety.processesReadOnly")
              : t("safety.processesNormal")
          }
        >
          <Switch checked={processes()} disabled={safety()?.jail !== "readOnly"} onChange={(next) => void allowProcesses(next)} aria-label={t("safety.processes")} />
        </FormRow>
      </FormGroup>

      <Show when={experimental()}>
        <Suspense>
          <WeakWriterControls />
        </Suspense>
      </Show>

      <Show when={workspace()} fallback={<p class="sc-muted">{t("safety.loading")}</p>}>
        {(ws) => (
          <FormGroup title={t("safety.liveTitle")} description={t("safety.liveDesc")}>
            <FormRow label={t("safety.protectedRow")} stacked>
              <PatternEditor label={t("safety.protectedLabel")} patterns={ws().protectedBranches} placeholder={t("safety.protectedPh")} onChange={(next) => void save((w) => setProtected(w, next))} />
            </FormRow>
            <For each={repos()}>
              {(repo) => (
                <FormRow label={repo.name} description={t("safety.alsoLive", { list: effectiveLive(ws(), repo.id).join(", ") || t("safety.nothing") })} stacked>
                  <PatternEditor label={t("safety.liveOf", { name: repo.name })} patterns={ws().liveBranches?.[repo.id] ?? []} onChange={(next) => void save((w) => setLive(w, repo.id, next))} />
                </FormRow>
              )}
            </For>
          </FormGroup>
        )}
      </Show>

      <FormGroup title={t("safety.neverTitle")} description={t("safety.neverDesc")}>
        <Show when={safety()} fallback={<FormRow label={t("safety.na")} description={t("safety.naDesc")} />}>
          {(s) => (
            <>
              <FormRow label={t("safety.folders")} stacked><PatternChips label={t("safety.neverLabel")} patterns={s().neverAdd} /></FormRow>
              <FormRow label={t("safety.secrets")} description={t("safety.secretsDesc", { mb: Math.round(s().maxUntrackedBytes / 1024 / 1024) })} stacked>
                <PatternChips label={t("safety.secretLabel")} patterns={s().secretPatterns} />
              </FormRow>
            </>
          )}
        </Show>
      </FormGroup>
    </div>
  );
}
