import { createEffect, createMemo, createSignal, createUniqueId, For, on, Show, untrack } from "solid-js";
import { Dynamic } from "solid-js/web";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { ProviderEnforcement, ProviderInfo } from "../../ipc/providers";
import { BypassConfirmDialog } from "../../components/chat/BypassConfirmDialog";
import { modelLabel } from "../../components/chat/format";
import { ModeCards } from "../../components/chat/ModeCards";
import { openDockTab } from "../../platform/dock";
import { openSettings } from "../../platform/settings";
import type { RoleGroup } from "../../ipc/roles";
import type { AgentSummary, AutoInfo, PermissionMode } from "../../store/agent-types";
import { appMode } from "../../platform/mode";
import { newRunPrefill, takeNewRunPrefill } from "../../platform/newRun";
import { agentRoles, selectAgent, startRun } from "../../store/agents";
import { repos } from "../../store/workspace";
import { activeId } from "../../store/workspaces";
import { Badge, Button, Checkbox, Dialog, Icon, Kbd, ListChecks, RepoBadge, TextArea, toast } from "../../ui-kit";
import { CapsMatrix } from "../providers/CapsMatrix";
import { ProviderMark } from "../providers/ProviderMark";
import { providerName } from "../providers/catalog";
import { roleGate, roleKind, TIER_LABEL, TIER_TONE, tierFor } from "../providers/enforcement";
import { AutoCard, type UntrustedRole } from "./AutoCard";
import { PERMISSION_TITLES } from "../roles/rolesLogic";
import { loadServers, servers } from "../servers/store";
import { McpRunPicker, mcpStartIds } from "./mcpSeam";
import { autoReasonText, chosenProvider, clampCounts, clampMode, defaultRepos, initialMode, neutralRole, numberedPrompt, placementRows, placementSummary, planRuns, providerBlocker, providerChoices, startBlocker, startErrorText, startRequest, THIS_MAC, toggleRepo, totalRuns, type RunMode } from "./newRunLogic";
import { roleColor } from "./roleColors";
import { newRunOpen, setCentreView, setNewRunOpen } from "./state";
import { WhereToRun } from "./WhereToRun";
import { AttachButton, AttachmentChips } from "../attachments/Chips";
import { createComposerAttachments } from "../attachments/composer";
import { promptWithAttachments, takePendingForNewRun } from "../attachments/newRunPrompt";
import "./runs.css";

/** Starts a run: role, repository scope, first prompt. Opened by the `runs.new` command in either mode. */
const repoLabel = (id: string) => repos().find((r) => r.id === id)?.name ?? id;

export function NewRunDialog() {
  const [role, setRole] = createSignal<string | undefined>(undefined);
  const [repoIds, setRepoIds] = createSignal<string[]>([]);
  const [prompt, setPrompt] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>(undefined);
  // Offered only after the engine refused with `noSafetyNet` (Rewind could not snapshot a repo); one run, then it resets.
  const [noNet, setNoNet] = createSignal(false);
  const [skipNet, setSkipNet] = createSignal(false);

  const [picked, setPicked] = createSignal<string | undefined>(undefined);
  const [providers, setProviders] = createSignal<ProviderInfo[]>([]);
  const [runnable, setRunnable] = createSignal<ReadonlySet<string>>(new Set());
  const [enforcement, setEnforcement] = createSignal<ProviderEnforcement[]>([]);

  // Auto is the default: a lead agent starts at once and hands work to the roles. `role` is today's single-role run.
  const [mode, setMode] = createSignal<RunMode>("auto");
  const [autoProvider, setAutoProvider] = createSignal("claude");
  const [autoInfo, setAutoInfo] = createSignal<AutoInfo | undefined>(undefined);
  const [autoLoading, setAutoLoading] = createSignal(true);
  const [autoError, setAutoError] = createSignal<string | undefined>(undefined);
  const [fellBack, setFellBack] = createSignal<string | undefined>(undefined);
  const [groups, setGroups] = createSignal<RoleGroup[]>([]);
  const [noticeDone, setNoticeDone] = createSignal(true);
  let autoSeq = 0;

  // The permission mode of the run ((design notes: permission-modes-spec) 7.1). It follows the last mode used until the person clicks a card.
  const [permission, setPermission] = createSignal<PermissionMode>("automatic");
  const [touched, setTouched] = createSignal(false);
  const [lastMode, setLastMode] = createSignal<PermissionMode | undefined>(undefined);
  const [supported, setSupported] = createSignal<PermissionMode[]>([]);
  // Bypass was confirmed for THIS submit: the host refuses the mode without it, and re-opening the dialog resets it.
  const [bypassOk, setBypassOk] = createSignal(false);
  const [confirmingBypass, setConfirmingBypass] = createSignal(false);
  const [mcpValue, setMcpValue] = createSignal<string[]>([]);
  // Where the runs go: how many on this Mac and on each server. Shown only when a server is enabled; with none the dialog starts one run here, as ever.
  const [counts, setCounts] = createSignal<Record<string, number>>({ [THIS_MAC]: 1 });
  const [numbering, setNumbering] = createSignal<boolean | undefined>(undefined);
  const rows = createMemo(() => placementRows(servers(), t("runs.where.thisMac")));
  const whereShown = () => servers().some((s) => s.cfg.enabled);
  const placed = createMemo(() => clampCounts(counts(), rows()));
  const total = () => totalRuns(placed(), rows());
  const modesLegend = createUniqueId();
  let modesSeq = 0;

  const current = () => agentRoles().find((r) => r.name === role());
  const claudeAuto = () => mode() === "auto" && autoProvider() === "claude";
  /** The provider this run goes to, whatever the form: the Auto provider, or the role's (picked) one. */
  const modeProvider = () => (mode() === "auto" ? autoProvider() : (provider() ?? current()?.provider ?? "claude"));
  const draft = () => ({
    role: role(),
    repoIds: repoIds(),
    prompt: prompt(),
    mode: claudeAuto() ? ("auto" as const) : ("role" as const),
    permission: permission(),
    ...(McpRunPicker ? { mcpServers: mcpStartIds(mcpValue(), modeProvider()) } : {}),
  });
  const att = createComposerAttachments({ key: "newrun", get label() { return t("attach.promptLabel"); }, provider: () => (mode() === "auto" ? autoProvider() : current()?.provider ?? "claude"), caps: () => "files", root: () => document.querySelector<HTMLElement>(".newrun") ?? undefined, priority: 95, active: newRunOpen });
  const choices = createMemo(() => providerChoices(current(), providers(), runnable(), enforcement()));
  const provider = () => chosenProvider(picked(), current(), choices());
  const autoChoices = createMemo(() => {
    const neutral = neutralRole(agentRoles());
    return neutral ? providerChoices({ provider: "claude", permission: neutral.permission }, providers(), runnable(), enforcement()) : [];
  });
  /** The write gate of the chosen provider, per mode: a provider that has not proven its enforcement cannot take a mode that changes files. */
  const unavailable = createMemo(() => {
    const pid = modeProvider();
    const info = providers().find((p) => p.id === pid);
    const out: Partial<Record<PermissionMode, string>> = {};
    for (const m of supported()) {
      const gate = roleGate(pid, info?.name ?? providerName(pid), m, tierFor(enforcement(), pid, roleKind(m)).tier, info?.allowWeakWriter === true);
      if (!gate.ok && gate.reason) out[m] = gate.reason;
    }
    return out;
  });
  const usable = () => supported().filter((m) => !unavailable()[m]);
  const blocker = () =>
    startBlocker(draft(), agentRoles()) ?? (claudeAuto() && autoLoading() ? t("runs.auto.loading") : undefined) ?? providerBlocker(provider() ?? current()?.provider, choices()) ?? unavailable()[permission()] ?? (whereShown() && total() === 0 ? t("runs.where.pick") : undefined) ?? att.store.blocker();
  const untrusted = createMemo((): UntrustedRole[] =>
    claudeAuto()
      ? groups().flatMap((g) => {
          const repos = [...new Set(g.copies.filter((c) => c.trust === "untrusted" && c.repoId && repoIds().includes(c.repoId)).map((c) => repoLabel(c.repoId!)))];
          return g.delegate.reason === "untrusted" || repos.length > 0 ? (repos.length > 0 ? [{ name: g.name, repos }] : []) : [];
        })
      : [],
  );

  const applyPrefill = () => {
    const prefill = takeNewRunPrefill();
    if (!prefill) return;
    setPrompt(prefill.prompt);
    if (prefill.repoIds?.length) setRepoIds(prefill.repoIds);
  };

  const pick = (name: string | undefined) => {
    setRole(name);
    setPicked(undefined);
    setRepoIds(defaultRepos(agentRoles().find((r) => r.name === name), repos().map((r) => r.id)));
  };

  /** "Run as role...": today's pickers, starting at the first role. */
  const enterRoleMode = () => {
    setMode("role");
    setAutoProvider("claude");
    pick(agentRoles()[0]?.name);
  };
  const backToAuto = () => {
    setMode("auto");
    setFellBack(undefined);
    setRole(undefined);
    setPicked(undefined);
  };
  /** Auto on another provider is one agent with its neutral read-only role; Claude is the lead with delegation. */
  const chooseAutoProvider = (id: string) => {
    setAutoProvider(id);
    setPicked(undefined);
    if (id === "claude") return setRole(undefined);
    setRole(neutralRole(agentRoles())?.name);
    setPicked(id);
  };
  const loadAuto = () => {
    const n = ++autoSeq;
    setAutoLoading(true);
    ipc.agentsAutoInfo(repoIds(), permission()).then(
      (info) => n === autoSeq && (setAutoInfo(info), setAutoError(undefined)),
      (e) => n === autoSeq && (setAutoInfo(undefined), setAutoError((e as { message?: string } | null)?.message ?? String(e))),
    ).finally(() => n === autoSeq && setAutoLoading(false));
  };
  const loadGroups = () => void ipc.roles.groups().then(setGroups, () => setGroups([]));
  const trust = async (name: string) => {
    const g = groups().find((x) => x.name === name);
    try {
      for (const c of g?.copies ?? []) if (c.trust === "untrusted" && c.contentHash && c.repoId && repoIds().includes(c.repoId)) await ipc.roles.setTrust(name, c.contentHash, true);
    } catch (e) {
      toast.error(t("roles.deleteFailed"), (e as { message?: string }).message ?? String(e));
    }
    loadGroups();
    loadAuto();
  };
  const dismissNotice = () => {
    setNoticeDone(true);
    void ipc.settings.set("roles", { derivationNoticeDone: true }).catch(() => {});
  };

  /** What the chosen provider can run in. A failure leaves the three modes every provider has. */
  const loadModes = (provider: string) => {
    const n = ++modesSeq;
    ipc.agentModes(provider).then(
      (list) => n === modesSeq && setSupported(list),
      () => n === modesSeq && setSupported(["readOnly", "ask", "edit"]),
    );
  };
  const pickMode = (m: PermissionMode) => {
    setTouched(true);
    if (m === permission()) return;
    // Bypass opens its confirmation first: the card only changes when it is confirmed, Cancel leaves the previous mode.
    if (m === "bypass") return setConfirmingBypass(true);
    setBypassOk(false);
    setPermission(m);
  };

  // Opening proposes the first role and its repos; the user can change both.
  createEffect(
    on(newRunOpen, (open) => {
      if (!open) return;
      setError(undefined);
      setMode("auto");
      setAutoProvider("claude");
      setFellBack(undefined);
      setRole(undefined);
      setPicked(undefined);
      setRepoIds([]);
      setTouched(false);
      setBypassOk(false);
      setConfirmingBypass(false);
      setMcpValue([]);
      setCounts({ [THIS_MAC]: 1 });
      setNumbering(undefined);
      void loadServers();
      loadGroups();
      void ipc.settings.get("roles").then((v) => setNoticeDone(v.derivationNoticeDone === true), () => {});
      // The mode used last is this dialog's default (Bypass never is); a read failure leaves the initial default.
      void ipc.settings.get("runs").then((v) => setLastMode(typeof v.lastMode === "string" ? (v.lastMode as PermissionMode) : undefined), () => {});
      // From the backend's cache; nothing is started. A failure leaves the picker with the role's own provider.
      void Promise.all([ipc.providers.list(), ipc.roles.capabilities(), ipc.providers.enforcement()]).then(
        ([list, caps, enf]) => {
          setProviders(list);
          setRunnable(new Set(caps.filter((c) => c.models.length > 0).map((c) => c.provider)));
          setEnforcement(enf);
        },
        () => {},
      );
      const dropped = takePendingForNewRun(); // files dropped on the window with no composer visible
      if (dropped.length) void att.store.addDropItems(dropped);
      // Another module (Happy tasks) asked for the dialog with a prompt and a repository scope; only the form is filled.
      applyPrefill();
    }),
  );
  // The same request while the dialog is already open.
  createEffect(on(newRunPrefill, (p) => p && newRunOpen() && applyPrefill(), { defer: true }));
  // Roles arrive after the store loads; adopt the first one if "Run as role..." was opened before that.
  createEffect(() => newRunOpen() && mode() === "role" && autoProvider() === "claude" && !role() && agentRoles().length > 0 && pick(agentRoles()[0].name));
  // What Auto would start with: read on open and whenever the repositories or the mode change (Plan and Ask take no writer lease, so they do not queue).
  createEffect(on([newRunOpen, () => repoIds().join(","), permission], ([open]) => open && loadAuto()));
  // The modes the chosen provider supports.
  createEffect(on([newRunOpen, modeProvider], ([open, p]) => open && loadModes(p)));
  // The mode follows the defaults until a card is clicked: the last used mode, Plan for a read-only role, the nearest one the provider and its gate allow.
  createEffect(() => {
    const ok = usable();
    if (!newRunOpen() || ok.length === 0) return;
    const now = untrack(permission);
    const next = touched() ? (ok.includes(now) ? now : clampMode(now, ok)) : initialMode(lastMode(), ok, mode() === "role" ? current() : undefined);
    if (next === now) return;
    if (now === "bypass") setBypassOk(false);
    setPermission(next);
  });
  // Auto that cannot run (Claude off, kill switch, old CLI) falls back to the role picker, but only once the answer is in: never a flash of role mode while it loads.
  createEffect(() => {
    if (!newRunOpen() || autoLoading() || mode() !== "auto" || autoProvider() !== "claude") return;
    const info = autoInfo();
    if (autoError() || (info && !info.available)) {
      setFellBack(autoError() ? autoError() : autoReasonText(info?.reason) || t("runs.auto.disabled"));
      enterRoleMode();
    }
  });

  const start = async () => {
    if (blocker() || busy()) return;
    setBusy(true);
    setError(undefined);
    try {
      const wanted = provider();
      const flags = { ...(skipNet() ? { runWithoutSafetyNet: true } : {}), ...(permission() === "bypass" && bypassOk() ? { confirmBypass: true } : {}) };
      const base = await promptWithAttachments(prompt().trim(), att.store);
      const jobs = whereShown() ? planRuns(placed(), rows()) : [{ name: "", index: 1, of: 1 }];
      const numbered = jobs.length > 1 && (numbering() ?? true);
      // One after the other, never in parallel: each start takes the writer lease and the slots the next one looks at.
      const started: AgentSummary[] = [];
      const failures: { name: string; error: unknown }[] = [];
      for (const job of jobs) {
        try {
          const request = startRequest({ ...draft(), prompt: numbered ? numberedPrompt(base, job) : base }, current(), wanted, "location" in job ? job.location : undefined);
          started.push(await startRun(request, Object.keys(flags).length ? flags : undefined));
        } catch (e) {
          failures.push({ name: job.name, error: e });
        }
      }
      const failureLines = failures.map((f) => t("runs.where.failedLine", { name: f.name, message: startErrorText(f.error) }));
      if (started.length === 0) {
        // Nothing started: the dialog stays, with the reason (a single run shows the host's text as before).
        setNoNet((failures[0].error as { code?: string } | null)?.code === "noSafetyNet");
        setError(jobs.length === 1 ? startErrorText(failures[0].error) : failureLines.join(" "));
        return;
      }
      const run = started[0];
      if (started.length > 1) void selectAgent(run.agentId);
      if (failures.length > 0) toast.error(t("runs.where.someFailed", { count: failures.length }), failureLines.join("\n"));
      void ipc.settings.set("runs", { lastMode: permission() }).catch(() => {});
      if (wanted && run.provider !== wanted) toast.warn(t("runs.new.otherProvider", { actual: run.provider, wanted }), t("runs.new.otherProviderDesc"));
      setPrompt("");
      setNoNet(false);
      setSkipNet(false);
      att.store.rotate();
      setNewRunOpen(false);
      setCentreView("run");
      if (appMode() === "editor") openDockTab("agents");
    } catch (e) {
      setNoNet((e as { code?: string } | null)?.code === "noSafetyNet");
      setError(startErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
    <Dialog
      open={newRunOpen()}
      onClose={() => setNewRunOpen(false)}
      title={t("runs.new.title")}
      description={t("runs.new.desc")}
      size="xl"
      class="newrun"
      footer={
        <>
          <span class="newrun__hint">
            <Show when={blocker()} fallback={<><Kbd keys={["⌘", "⏎"]} /> {t("runs.new.startHint")}</>}>
              {blocker()}
            </Show>
          </span>
          <Button variant="ghost" onClick={() => setNewRunOpen(false)}>
            {t("runs.cancel")}
          </Button>
          <Button variant="primary" loading={busy()} disabled={!!blocker()} onClick={() => void start()}>
            {t("runs.new.start")}
          </Button>
        </>
      }
    >
      <div class="newrun__grid">
        <div class="newrun__main">
          <Show
            when={mode() === "auto"}
            fallback={
              <>
              <div class="newrun__asrole">
                <span class="newrun__asrole-title">{t("runs.new.runAs")}</span>
                <span class="newrun__asrole-hint">{t("runs.new.runAsHint")}</span>
                <Show when={autoInfo()?.available && !autoLoading()}>
                  <Button size="sm" variant="ghost" onClick={backToAuto}>{t("runs.new.backToAuto")}</Button>
                </Show>
              </div>
              <Show when={fellBack()}>{(why) => <p class="newrun__provider-note" role="status">{t("runs.new.autoUnavailable", { reason: why() })}</p>}</Show>
          <fieldset class="newrun__field">
            <legend class="newrun__label">{t("runs.role")}</legend>
            <div class="newrun__roles" role="radiogroup" aria-label={t("runs.role")}>
              <For each={agentRoles()}>
                {(r) => (
                  <button type="button" role="radio" class="newrun__role" aria-checked={role() === r.name} onClick={() => pick(r.name)}>
                    <span class="newrun__role-name">
                      <span class="run-card__swatch" style={{ background: roleColor(r.name) ?? "var(--text-4)" }} aria-hidden="true" />
                      {r.name}
                    </span>
                    <span class="newrun__role-desc">{r.description}</span>
                    <span class="newrun__role-chips">
                      <Badge size="sm">{modelLabel(r.model)}</Badge>
                      <Badge size="sm" title={r.effort ? undefined : t("runs.new.noEffort")}>
                        {t("runs.new.effort", { value: r.effort ?? t("runs.na") })}
                      </Badge>
                      <Badge size="sm">{PERMISSION_TITLES[r.permission]}</Badge>
                    </span>
                  </button>
                )}
              </For>
            </div>
          </fieldset>
          <Show when={choices().length > 0}>
            <fieldset class="newrun__field">
              <legend class="newrun__label">{t("runs.provider")}</legend>
              <div class="newrun__providers" role="radiogroup" aria-label={t("runs.provider")}>
                <For each={choices()}>
                  {(c) => (
                    <button type="button" role="radio" class="newrun__provider" aria-checked={provider() === c.id} aria-disabled={!c.ok} data-ok={c.ok ? "" : undefined} title={c.note} onClick={() => c.ok && setPicked(c.id)}>
                      <ProviderMark id={c.id} />
                      <span class="newrun__provider-name">{c.name}</span>
                      <Badge size="sm" tone={TIER_TONE[c.tier]}>{TIER_LABEL[c.tier]}</Badge>
                    </button>
                  )}
                </For>
              </div>
              <Show when={choices().find((c) => c.id === provider())?.note}>{(note) => <small class="newrun__provider-note">{note()}</small>}</Show>
              <Show when={provider()}>{(id) => <span class="newrun__provider-caps"><CapsMatrix id={id()} name={choices().find((c) => c.id === id())?.name ?? id()} /></span>}</Show>
              <Show when={choices().some((c) => !c.ok && c.id !== current()?.provider)}>
                <small class="newrun__provider-note">{t("runs.new.greyed")}</small>
              </Show>
            </fieldset>
          </Show>
              </>
            }
          >
            <fieldset class="newrun__field newrun__auto">
              <legend class="newrun__label">
                {t("runs.new.auto")}
                <span class="newrun__auto-mark">{t("runs.new.autoDefault")}</span>
              </legend>
              <p class="newrun__auto-desc">{t("runs.new.autoDesc")}</p>
              <Show when={autoChoices().length > 1}>
                <div class="newrun__providers" role="radiogroup" aria-label={t("runs.auto.provider")}>
                  <For each={autoChoices()}>
                    {(c) => (
                      <button type="button" role="radio" class="newrun__provider" aria-checked={autoProvider() === c.id} aria-disabled={!c.ok} data-ok={c.ok ? "" : undefined} title={c.note} onClick={() => c.ok && chooseAutoProvider(c.id)}>
                        <ProviderMark id={c.id} />
                        <span class="newrun__provider-name">{c.name}</span>
                        <Show when={c.id !== "claude"}>
                          <Badge size="sm" tone={TIER_TONE[c.tier]}>{TIER_LABEL[c.tier]}</Badge>
                        </Show>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
              <AutoCard
                info={autoInfo()}
                loading={autoProvider() === "claude" && autoLoading()}
                otherProvider={autoProvider() === "claude" ? undefined : (providers().find((p) => p.id === autoProvider())?.name ?? autoProvider())}
                untrusted={untrusted()}
                showFirstLaunch={!noticeDone() && autoProvider() === "claude"}
                onDismissFirstLaunch={dismissNotice}
                onTrust={(name) => void trust(name)}
                onManage={() => (setNewRunOpen(false), openSettings("roles"))}
              />
              <Show when={autoProvider() !== "claude" && provider() && choices().find((c) => c.id === provider())?.note}>{(note) => <small class="newrun__provider-note">{note()}</small>}</Show>
            </fieldset>
            <Button class="newrun__asrole-open" size="sm" variant="ghost" aria-expanded={false} onClick={enterRoleMode}>
              {t("runs.new.runAs")}
            </Button>
          </Show>
          <fieldset class="newrun__field newrun__modes-field">
            <legend class="newrun__label" id={modesLegend}>
              {t("modes.picker.label")}
            </legend>
            <div class="newrun__modes">
              <ModeCards modes={supported()} value={permission()} onChange={pickMode} labelledBy={modesLegend} unavailable={unavailable()} confirm={["bypass"]} disabled={busy()} />
            </div>
            <Show when={mode() === "role" && !touched() && permission() === "readOnly" && current()?.permission === "readOnly"}>
              <small class="newrun__provider-note" role="status">
                {t("modes.picker.roleReadOnly")}
              </small>
            </Show>
          </fieldset>
          <fieldset class="newrun__field">
            <legend class="newrun__label">
              {t("runs.repos")}
              <span class="newrun__links">
                <Button size="sm" variant="ghost" onClick={() => setRepoIds(repos().map((r) => r.id))}>
                  {t("runs.all")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRepoIds([])}>
                  {t("runs.none")}
                </Button>
              </span>
            </legend>
            <div class="newrun__repos" role="group" aria-label={t("runs.repos")}>
              <For each={repos()}>
                {(r) => (
                  <Button class="newrun__repo" variant="secondary" size="sm" aria-pressed={repoIds().includes(r.id)} data-picked={repoIds().includes(r.id) ? "" : undefined} onClick={() => setRepoIds(toggleRepo(repoIds(), r.id))}>
                    <RepoBadge color={r.color} badge={r.badge} size={16} />
                    {r.name}
                  </Button>
                )}
              </For>
            </div>
          </fieldset>
          <Show when={whereShown()}>
            <WhereToRun
              rows={rows()}
              counts={placed()}
              summary={placementSummary(placed(), rows())}
              numbering={numbering() ?? total() > 1}
              disabled={busy()}
              onCount={(key, n) => setCounts({ ...placed(), [key]: n })}
              onNumbering={setNumbering}
              onSettings={() => (setNewRunOpen(false), openSettings("servers"))}
            />
          </Show>
          <Show when={McpRunPicker}>
            <div class="newrun__field newrun__mcp">
              <Dynamic component={McpRunPicker} value={mcpValue()} onChange={setMcpValue} provider={modeProvider()} mode={permission()} workspaceId={activeId()} disabled={busy()} />
            </div>
          </Show>
          <label class="newrun__field">
            <span class="newrun__label">{t("runs.new.prompt")}</span>
            <TextArea
              data-autofocus
              aria-label={t("runs.new.prompt")}
              placeholder={t("runs.new.promptPlaceholder")}
              minRows={4}
              maxRows={10}
              value={prompt()}
              onInput={(e) => setPrompt(e.currentTarget.value)}
              onPaste={att.onPaste}
              onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && (e.preventDefault(), void start())}
            />
          </label>
          <AttachmentChips items={att.store.items()} provider={att.provider()} onRemove={(id) => void att.store.remove(id)} onConfirm={(id) => void att.store.confirm(id)} />
          <div class="newrun__attach"><AttachButton onFiles={att.pick} /></div>
          <Show when={error()}>{(msg) => <p class="newrun__error" role="alert">{msg()}</p>}</Show>
          <Show when={noNet()}>
            <Checkbox checked={skipNet()} onChange={setSkipNet} label={t("runs.new.noNet")} />
          </Show>
        </div>
        <aside class="newrun__templates" aria-label={t("runs.new.templates")}>
          <h3 class="newrun__label">{t("runs.new.templates")}</h3>
          <div class="newrun__tpl-empty">
            <Icon icon={ListChecks} size={16} />
            <p>{t("runs.new.templatesEmpty")}</p>
            <Button size="sm" variant="secondary" disabled>
              {t("runs.new.savePrompt")}
            </Button>
          </div>
        </aside>
      </div>
    </Dialog>
    <BypassConfirmDialog
      open={confirmingBypass()}
      context="start"
      onCancel={() => setConfirmingBypass(false)}
      onConfirm={() => {
        setConfirmingBypass(false);
        setBypassOk(true);
        setPermission("bypass");
      }}
    />
    </>
  );
}
