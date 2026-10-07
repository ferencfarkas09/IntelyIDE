import type { Effort, PermissionMode } from "@intely/protocol";
import { createMemo, createSignal, For, Index, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { ProviderEnforcement, ProviderInfo } from "../../ipc/providers";
import { capsOfProvider } from "../../ipc/providerCaps";
import type { Role, RoleCopy, RoleGroup, RoleProviderCaps, RolesStatus } from "../../ipc/roles";
import { permissionMeaning } from "../providers/catalog";
import { CapsMatrix } from "../providers/CapsMatrix";
import { EnforcementBadge } from "../providers/EnforcementBadge";
import { TestRun } from "../providers/TestRun";
import { roleGate, roleKind, tierFor, TIER_LABEL, WRITE_MIN_TIER } from "../providers/enforcement";
import { repos } from "../../store/workspace";
import { confirmDialog } from "../editor/dialogs";
import { Badge, Button, ChevronRight, EmptyState, Eye, EyeOff, Icon, IconButton, Info, Input, Plus, Select, ShieldAlert, Skeleton, Sparkles, TextArea, toast, TriangleAlert } from "../../ui-kit";
import { AutoSettings, OPTIMAL_AGENTS } from "./AutoSettings";
import { DeleteRoleDialog, type DeleteRequest } from "./DeleteRoleDialog";
import {
  canDelete,
  clampEffort,
  deleteTargets,
  derivedEditors,
  driftRows,
  effortOptions,
  groupRows,
  hasIssues,
  isDirty,
  mismatchLabel,
  modelOptions,
  newRole,
  PERMISSION_TITLES,
  permissionText,
  providerOf,
  reconcile,
  ROLE_COLORS,
  scopeChips,
  toolChips,
  untrustedCopies,
  validateRole,
  warningText,
  winnerReasonText,
} from "./rolesLogic";
import "./roles.css";

const message = (e: unknown): string => (e as { message?: string }).message ?? String(e);
const repoName = (id: string | undefined) => repos().find((r) => r.id === id)?.name ?? id ?? "";
const pinOf = (c: RoleCopy) => (c.scope === "global" ? "global" : `repo:${c.repoId}`);

/** Settings section: the roles agents run as, one row per name, with provider, model, effort, permission and tools chosen from what the provider offers. */
export default function RolesSection() {
  const [caps, setCaps] = createSignal<RoleProviderCaps[]>([]);
  const [groups, setGroups] = createSignal<RoleGroup[]>([]);
  /** Every role file as its own Role (copies included): the field diff of a differing copy reads these. */
  const [files, setFiles] = createSignal<Role[]>([]);
  const [saved, setSaved] = createSignal<Role[]>([]);
  const [drafts, setDrafts] = createSignal<Role[]>([]);
  const [status, setStatus] = createSignal<RolesStatus | undefined>(undefined);
  const mismatches = () => status()?.mismatches ?? [];
  const [noticeDone, setNoticeDone] = createSignal(true);
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());
  const [showHidden, setShowHidden] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal<string | undefined>(undefined);
  const [rowError, setRowError] = createSignal<Record<string, string>>({});
  const [busy, setBusy] = createSignal(false);
  const [providers, setProviders] = createSignal<ProviderInfo[]>([]);
  const [enforcement, setEnforcement] = createSignal<ProviderEnforcement[]>([]);
  const [armed, setArmed] = createSignal(false);
  const [autoVersion, setAutoVersion] = createSignal(0);
  const [deleting, setDeleting] = createSignal<DeleteRequest | undefined>(undefined);
  let disarm: ReturnType<typeof setTimeout> | undefined;

  const savedById = createMemo(() => new Map(saved().map((r) => [r.id, r])));
  const groupOf = (id: string) => groups().find((g) => g.role.id === id);
  const corrupt = createMemo(() => status()?.overlayCorrupt === true || groups().some((g) => g.role.permissionSource === "overlayCorrupt"));

  /** Takes a fresh read; drafts the user is still editing survive it (except the ones just saved). */
  const apply = (gs: RoleGroup[], fs: Role[], skip: readonly string[] = []) => {
    const old = drafts();
    const oldSaved = savedById();
    const fresh = gs.map((g) => g.role);
    const keep = old.filter((d) => !skip.includes(d.id) && isDirty(d, oldSaved.get(d.id)) && !(!oldSaved.has(d.id) && fresh.some((r) => r.name === d.name)));
    setGroups(gs);
    setFiles(fs);
    setSaved(fresh);
    setDrafts([...fresh.map((r) => keep.find((d) => d.id === r.id) ?? structuredClone(r)), ...keep.filter((d) => !fresh.some((r) => r.id === d.id))]);
  };

  const read = async () => {
    const [gs, fs, st] = await Promise.all([ipc.roles.groups(), ipc.roles.list(), ipc.roles.status().catch(() => undefined)]);
    setStatus(st);
    return { gs, fs };
  };

  const load = async () => {
    try {
      const [c, { gs, fs }] = await Promise.all([ipc.roles.capabilities(), read()]);
      setCaps(c);
      apply(gs, fs);
      setLoadError(undefined);
    } catch (e) {
      setLoadError(message(e));
    } finally {
      setLoading(false);
    }
  };
  const reload = async (skip: readonly string[] = []) => {
    try {
      const { gs, fs } = await read();
      apply(gs, fs, skip);
    } catch (e) {
      toast.error(t("roles.loadFailed"), message(e));
    }
  };

  onMount(() => {
    void load();
    // Both come from the backend's cache and start nothing; a failure only means the dropdown lists the providers that have models.
    void ipc.providers.list().then(setProviders, () => {});
    void ipc.providers.enforcement().then(setEnforcement, () => {});
    void ipc.settings.get("roles").then((v) => setNoticeDone(v.derivationNoticeDone === true), () => {});
  });

  const nameOf = (id: string | undefined) => providers().find((p) => p.id === id)?.name ?? caps().find((c) => c.provider === id)?.label ?? id ?? "";
  /** The gate of one provider and mode, from the recorded enforcement ((design notes: providers-plan) 3.1). */
  const gateOf = (provider: string | undefined, mode: Role["permission"]) => {
    const id = provider ?? caps()[0]?.provider ?? "claude";
    return roleGate(id, nameOf(id), mode ?? "readOnly", tierFor(enforcement(), id, roleKind(mode ?? "readOnly")).tier, providers().find((p) => p.id === id)?.allowWeakWriter === true);
  };
  const blocker = (role: Pick<Role, "provider" | "permission">) => gateOf(role.provider, role.permission).reason;
  const providerOptions = (current: string | undefined) => {
    const withModels = new Set(caps().map((c) => c.provider));
    const rows = providers().map((p) => {
      const usable = p.enabled && p.state !== "off" && withModels.has(p.id);
      const label = !withModels.has(p.id) ? t("roles.noModels", { name: p.name }) : !p.enabled ? t("roles.enableInSettings", { name: p.name }) : p.name;
      return { value: p.id, label, disabled: !usable && p.id !== current };
    });
    const missing = caps().filter((c) => !rows.some((r) => r.value === c.provider)).map((c) => ({ value: c.provider, label: c.label, disabled: false }));
    return [...rows, ...missing];
  };

  const issuesOf = (role: Role) => validateRole(role, caps(), drafts(), blocker);
  const dirty = createMemo(() => drafts().filter((d) => isDirty(d, savedById().get(d.id))));
  const saveable = createMemo(() => dirty().filter((d) => !hasIssues(issuesOf(d))));
  const view = createMemo(() => {
    const byId = new Map(groups().map((g) => [g.role.id, g]));
    const { rows, hiddenCount } = groupRows(groups(), showHidden());
    const order = new Map(rows.map((g, i) => [g.role.id, i]));
    const shown = drafts().filter((d) => !byId.has(d.id) || !byId.get(d.id)!.hidden || showHidden());
    return { shown: shown.sort((a, b) => (order.get(a.id) ?? 1e6) - (order.get(b.id) ?? 1e6)), hiddenCount };
  });
  const noticeNames = createMemo(() => derivedEditors(groups()));

  const edit = (id: string, patch: Partial<Role>, snap = false) =>
    setDrafts((all) => all.map((r) => (r.id === id ? (snap ? reconcile({ ...r, ...patch }, caps()) : { ...r, ...patch }) : r)));
  const toggle = (id: string) => setOpen((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set(s).add(id)));
  const toggleIn = (list: readonly string[] | undefined, item: string) => ((list ?? []).includes(item) ? (list ?? []).filter((x) => x !== item) : [...(list ?? []), item]);

  /** A change to a role file asks first (the engine refuses with `confirmWrite` and writes nothing); the old file is backed up. */
  const confirmed = async <T,>(run: (opts: { confirmWrite?: boolean }) => Promise<T>, title: string): Promise<T> => {
    try {
      return await run({});
    } catch (e) {
      if ((e as { code?: string } | null)?.code !== "confirmWrite") throw e;
      const answer = await confirmDialog({ title, description: t("roles.writeDesc"), confirmLabel: t("roles.writeConfirm") });
      if (answer !== "confirm") throw new Error(t("roles.notSaved"));
      return run({ confirmWrite: true });
    }
  };

  const saveRoles = async (list: Role[]) => {
    setBusy(true);
    let done = 0;
    const ok: string[] = [];
    for (const role of list) {
      try {
        await confirmed((opts) => ipc.roles.save(role, opts), t("roles.writeFileOf", { name: role.name }));
        setRowError(({ [role.id]: _drop, ...rest }) => rest);
        ok.push(role.id);
        done++;
      } catch (e) {
        const code = (e as { code?: string } | null)?.code;
        setRowError((m) => ({ ...m, [role.id]: code === "reservedName" ? t("roles.err.reservedName", { name: role.name }) : message(e) }));
      }
    }
    setBusy(false);
    if (done) toast.success(t("roles.saved", { count: done }));
    await reload(ok);
  };

  const preset = async () => {
    if (!armed()) {
      setArmed(true);
      disarm = setTimeout(() => setArmed(false), 4000);
      return;
    }
    clearTimeout(disarm);
    setArmed(false);
    try {
      await confirmed((opts) => ipc.roles.presetHappyTiering(opts), t("roles.writePreset"));
      // the Auto run is part of "optimal": the lead, its effort, the role cap and both switches
      await ipc.settings.set("agents", OPTIMAL_AGENTS);
      setAutoVersion((v) => v + 1);
      await load();
      toast.success(t("roles.presetApplied"), t("roles.presetAppliedDesc"));
    } catch (e) {
      toast.error(t("roles.presetFailed"), message(e));
    }
  };

  const guarded = async (id: string, run: () => Promise<unknown>) => {
    try {
      await run();
      setRowError(({ [id]: _drop, ...rest }) => rest);
      await reload();
    } catch (e) {
      setRowError((m) => ({ ...m, [id]: message(e) }));
    }
  };
  const setHidden = (g: RoleGroup, hidden: boolean) => guarded(g.role.id, () => ipc.roles.setHidden(g.name, hidden));
  const setPin = (g: RoleGroup, pin: string | null) => guarded(g.role.id, () => ipc.roles.setPin(g.name, pin));
  const trust = (g: RoleGroup, copies: RoleCopy[]) =>
    guarded(g.role.id, async () => {
      for (const c of copies) if (c.contentHash) await ipc.roles.setTrust(g.name, c.contentHash, true);
    });
  const resetAuto = (ids: string[]) => guarded(ids[0], () => ipc.roles.useAutomatic(ids));
  const useAutomaticAll = async () => {
    try {
      await ipc.roles.useAutomatic(mismatches().map((m) => m.id));
      await reload();
    } catch (e) {
      toast.error(t("roles.permission.useAutomaticFailed"), message(e));
    }
  };
  const resetOverlay = async () => {
    const answer = await confirmDialog({ title: t("roles.overlay.resetTitle"), description: t("roles.overlay.resetDesc"), confirmLabel: t("roles.overlay.resetConfirm"), danger: true });
    if (answer !== "confirm") return;
    try {
      await ipc.roles.resetOverlay();
      await reload();
    } catch (e) {
      toast.error(t("roles.overlay.resetFailed"), message(e));
    }
  };
  const dismissNotice = () => {
    setNoticeDone(true);
    void ipc.settings.set("roles", { derivationNoticeDone: true }).catch(() => {});
  };

  /** Makes every copy equal to the one in use (the engine backs the old files up and asks to write). */
  const makeIdentical = async (g: RoleGroup) => {
    const winner = g.copies.find((c) => c.id === g.winnerId);
    if (!winner) return;
    try {
      if (winner.scope === "repo") await confirmed((opts) => ipc.roles.resolveDrift(winner.id, winner.repoId ?? "", "repo", opts), t("roles.writeGlobalCopy", { name: g.name }));
      for (const c of g.copies.filter((x) => x.scope === "repo" && x.id !== winner.id && (winner.scope === "repo" || !x.sameAsWinner))) {
        await confirmed((opts) => ipc.roles.resolveDrift(c.id, c.repoId ?? "", "global", opts), t("roles.writeRepoCopy", { name: g.name }));
      }
      await reload();
    } catch (e) {
      toast.error(t("roles.resolveFailed"), message(e));
    }
  };

  const add = () => {
    const role = newRole(caps(), drafts().map((r) => r.id));
    setDrafts((all) => [...all, role]);
    setOpen((s) => new Set(s).add(role.id));
  };

  const fileOf = (id: string | undefined) => files().find((f) => f.id === id);

  return (
    <div class="roles">
      <Show when={!loading()} fallback={<div class="roles__loading"><Skeleton height={32} /><Skeleton height={32} /><Skeleton height={32} /></div>}>
        <Show when={!loadError()} fallback={<EmptyState tone="danger" icon={TriangleAlert} size="sm" title={t("roles.loadFailed")} description={loadError()} />}>
          <Show when={corrupt()}>
            <section class="roles__notice" data-tone="danger" role="alert" aria-label={t("roles.overlay.corruptAria")}>
              <p><Icon icon={ShieldAlert} size={14} /> {t("roles.overlay.corrupt")}</p>
              <div class="roles__drift-actions">
                <Button size="sm" variant="secondary" onClick={() => void resetOverlay()}>{t("roles.overlay.reset")}</Button>
              </div>
            </section>
          </Show>
          <For each={status()?.skippedDirs ?? []}>
            {(d) => (
              <section class="roles__notice" data-tone="warn" role="status" aria-label={t("roles.agentsDir.symlinkAria")}>
                <p><Icon icon={TriangleAlert} size={14} /> {t("roles.agentsDir.symlink", { repo: repoName(d.repoId) })}</p>
              </section>
            )}
          </For>
          <Show when={status()?.globalDirTarget}>
            {(target) => <p class="roles__why roles__link-note">{t("roles.globalDirLink", { dir: status()!.globalDir, target: target() })}</p>}
          </Show>
          <Show when={mismatches().length > 0 && !corrupt()}>
            <section class="roles__notice" data-tone="warn" role="status" aria-label={t("roles.permission.mismatchAria")}>
              <p>{t("roles.permission.mismatchBar", { count: mismatches().length })}</p>
              <ul class="roles__mismatch">
                <For each={mismatches()}>
                  {(m) => (
                    <li>
                      <span>{mismatchLabel(m)}</span>
                      <Button size="sm" variant="secondary" onClick={() => void resetAuto([m.id])}>{t("roles.permission.useAutomatic")}</Button>
                    </li>
                  )}
                </For>
              </ul>
              <div class="roles__drift-actions">
                <Button size="sm" variant="primary" onClick={() => void useAutomaticAll()}>{t("roles.permission.useAutomaticAll")}</Button>
              </div>
            </section>
          </Show>
          <Show when={!noticeDone() && noticeNames().length > 0 && mismatches().length === 0 && !corrupt()}>
            <section class="roles__notice" data-tone="info" role="status" aria-label={t("roles.derivedNoticeAria")}>
              <p><Icon icon={Info} size={14} /> {t("roles.derivedNotice", { count: noticeNames().length, names: noticeNames().join(", ") })}</p>
              <div class="roles__drift-actions">
                <Button size="sm" variant="secondary" onClick={dismissNotice}>{t("roles.derivedNotice.ok")}</Button>
              </div>
            </section>
          </Show>
          <div class="roles__bar">
            <p class="roles__intro">{t("roles.intro")}</p>
            <Button size="sm" variant="secondary" icon={Sparkles} onClick={() => void preset()} title={t("roles.presetTip")}>
              {armed() ? t("roles.presetArmed") : t("roles.preset")}
            </Button>
            <Button size="sm" variant="secondary" icon={Plus} onClick={add}>
              {t("roles.new")}
            </Button>
          </div>
          <div class="roles__scroll">
            <table class="roles__table">
              <thead>
                <tr>
                  <th scope="col">{t("roles.col.role")}</th>
                  <th scope="col">{t("roles.f.provider")}</th>
                  <th scope="col">{t("roles.f.model")}</th>
                  <th scope="col">{t("roles.f.effort")}</th>
                  <th scope="col">{t("roles.f.permission")}</th>
                  <th scope="col" class="roles__end">
                    <span class="ui-sr-only">{t("roles.col.actions")}</span>
                  </th>
                </tr>
              </thead>
              <Index each={view().shown} fallback={<tbody><tr><td colSpan={6}><EmptyState size="sm" title={t("roles.empty")} description={t("roles.emptyDesc")} /></td></tr></tbody>}>
                {(role) => {
                  const group = () => groupOf(role().id);
                  const provider = () => providerOf(role(), caps());
                  const levels = () => effortOptions(role(), caps());
                  const issues = () => issuesOf(role());
                  const isOpen = () => open().has(role().id);
                  const err = () => rowError()[role().id];
                  const locked = () => role().builtin === true;
                  const perm = () => permissionText(role());
                  const chips = () => (group() ? scopeChips(group()!, repoName) : []);
                  const untrusted = () => (group() ? untrustedCopies(group()!) : []);
                  return (
                    <tbody class="roles__role" data-open={isOpen() ? "" : undefined} data-hidden={group()?.hidden ? "" : undefined}>
                      <tr>
                        <td>
                          <span class="roles__name">
                            <IconButton icon={ChevronRight} label={isOpen() ? t("roles.hideDetails", { name: role().name }) : t("roles.showDetails", { name: role().name })} size="sm" class="roles__chevron" data-open={isOpen() ? "" : undefined} onClick={() => toggle(role().id)} />
                            <span class="roles__swatch" style={{ background: role().color ?? "var(--text-4)" }} aria-hidden="true" />
                            <Input size="sm" aria-label={t("roles.roleName")} value={role().name} disabled={locked() || (group()?.copies.length ?? 0) > 1} invalid={!!issues().name} onInput={(e) => edit(role().id, { name: e.currentTarget.value })} />
                          </span>
                        </td>
                        <td>
                          <Select size="sm" aria-label={t("roles.f.provider")} disabled={locked()} value={role().provider ?? provider()?.provider} invalid={!!issues().provider} onChange={(p) => edit(role().id, { provider: p }, true)} options={providerOptions(role().provider ?? provider()?.provider)} />
                        </td>
                        <td>
                          <Select size="sm" aria-label={t("roles.f.model")} disabled={locked()} value={role().model} invalid={!!issues().model} onChange={(m) => edit(role().id, { model: m }, true)} options={modelOptions(provider()?.models ?? [], role().model)} />
                        </td>
                        <td>
                          <Select
                            size="sm"
                            aria-label={t("roles.f.effort")}
                            disabled={locked() || levels().length === 0}
                            title={levels().length === 0 ? t("roles.err.noEffortControl") : undefined}
                            value={levels().length === 0 ? "" : (role().effort ?? clampEffort(undefined, levels()) ?? "")}
                            invalid={!!issues().effort}
                            onChange={(e) => edit(role().id, { effort: e as Effort })}
                            options={levels().length === 0 ? [{ value: "", label: t("roles.na") }] : levels().map((l) => ({ value: l, label: l }))}
                          />
                          <Show when={levels().length > 0 && capsOfProvider(role().provider ?? provider()?.provider ?? "").effort.cap === "partial"}>
                            <Badge size="sm" tone="warn" class="roles__partial" title={capsOfProvider(role().provider ?? "").effort.note ?? t("roles.partialTip")}>{t("roles.partial")}</Badge>
                          </Show>
                        </td>
                        <td>
                          <Select
                            size="sm"
                            aria-label={t("roles.permissionMode")}
                            disabled={locked()}
                            value={role().permission}
                            invalid={!!issues().permission}
                            onChange={(p) => edit(role().id, { permission: p as PermissionMode, permissionExplicit: true })}
                            options={(provider()?.permissionModes ?? []).map((m) => {
                              const gate = gateOf(role().provider, m);
                              return { value: m, label: gate.ok ? PERMISSION_TITLES[m] : t("roles.needsTier", { title: PERMISSION_TITLES[m], tier: TIER_LABEL[WRITE_MIN_TIER] }), disabled: !gate.ok && m !== role().permission };
                            })}
                          />
                          <small class="roles__means" title={perm().why ? `${perm().means} ${perm().why}` : perm().means}>{perm().means}</small>
                        </td>
                        <td class="roles__end">
                          <span class="roles__actions">
                            <Show when={isDirty(role(), savedById().get(role().id))}>
                              <Button size="sm" variant="primary" loading={busy()} disabled={hasIssues(issues())} title={hasIssues(issues()) ? t("roles.fixFirst") : undefined} onClick={() => void saveRoles([role()])}>
                                {t("roles.save")}
                              </Button>
                            </Show>
                            <Show when={group()}>
                              {(g) => (
                                <IconButton icon={g().hidden ? Eye : EyeOff} size="sm" label={g().hidden ? t("roles.unhide") : t("roles.hide")} title={g().hidden ? t("roles.unhide") : t("roles.hideTip")} onClick={() => void setHidden(g(), !g().hidden)} />
                              )}
                            </Show>
                          </span>
                        </td>
                      </tr>
                      <Show when={group()}>
                        {(g) => (
                          <tr class="roles__meta">
                            <td colSpan={6}>
                              <span class="roles__chips-line">
                                <For each={chips()}>{(c) => <Badge size="sm" tone={c.kind === "repo" ? "info" : "neutral"} class="roles__scope">{c.label}</Badge>}</For>
                                <Show when={g().copies.length > 1}>
                                  <Badge size="sm" numeric>{t("roles.copies", { count: g().copies.length })}</Badge>
                                </Show>
                                <Show when={g().conflict}>
                                  <Badge tone="warn" size="sm" icon={TriangleAlert} title={t("roles.driftTip")}>{t("roles.chip.differ")}</Badge>
                                </Show>
                                <Show when={g().hidden}>
                                  <Badge size="sm">{t("roles.chip.hidden")}</Badge>
                                </Show>
                                <Show when={untrusted().length > 0}>
                                  <Badge tone="warn" size="sm" icon={ShieldAlert} title={t("roles.trust.untrustedTip")}>{t("roles.trust.untrusted")}</Badge>
                                  <Button size="sm" variant="secondary" class="roles__trust" onClick={() => void trust(g(), untrusted())}>{t("roles.trust.trustButton")}</Button>
                                </Show>
                              </span>
                            </td>
                          </tr>
                        )}
                      </Show>
                      <Show when={hasIssues(issues()) || err()}>
                        <tr class="roles__issues">
                          <td colSpan={6}>
                            <ul role="alert">
                              <For each={Object.values(issues())}>{(msg) => <li>{msg}</li>}</For>
                              <Show when={err()}>{(msg) => <li>{msg()}</li>}</Show>
                            </ul>
                          </td>
                        </tr>
                      </Show>
                      <Show when={isOpen()}>
                        <tr class="roles__details">
                          <td colSpan={6}>
                            <div class="roles__panel">
                              <div class="roles__provider" aria-label={t("roles.providerSafety")}>
                                <span class="roles__label">{t("roles.f.provider")}</span>
                                <span class="roles__provider-line">
                                  <EnforcementBadge provider={role().provider ?? provider()?.provider ?? "claude"} name={nameOf(role().provider ?? provider()?.provider)} list={enforcement()} mode={role().permission} installed={providers().find((p) => p.id === (role().provider ?? provider()?.provider))?.cli?.version} writerAllowed={providers().find((p) => p.id === (role().provider ?? provider()?.provider))?.allowWeakWriter === true} />
                                  <CapsMatrix id={role().provider ?? provider()?.provider ?? "claude"} name={nameOf(role().provider ?? provider()?.provider)} />
                                  <TestRun provider={role().provider ?? provider()?.provider ?? "claude"} name={nameOf(role().provider ?? provider()?.provider)} model={role().model} />
                                  <span class="roles__meaning">
                                    {t("roles.meaning", { provider: nameOf(role().provider ?? provider()?.provider), mode: PERMISSION_TITLES[role().permission ?? "readOnly"], meaning: permissionMeaning(role().provider ?? provider()?.provider ?? "", role().permission ?? "readOnly") })}
                                  </span>
                                </span>
                                <Show when={gateOf(role().provider, role().permission).caution}>{(text) => <small class="roles__caution">{text()}</small>}</Show>
                              </div>
                              <div class="roles__field roles__permission" role="group" aria-label={t("roles.f.permission")}>
                                <span class="roles__label">{t("roles.f.permission")}</span>
                                <p class="roles__means-full">{perm().means}</p>
                                <Show when={perm().why}>{(why) => <p class="roles__why">{why()}</p>}</Show>
                                <Show when={perm().ceiling}>
                                  <p class="roles__why" data-tone="warn">{t("roles.permission.ceilingNote")}</p>
                                </Show>
                                <Show when={role().permissionSource === "overlay" && group() && !locked()}>
                                  <div class="roles__drift-actions">
                                    <Button size="sm" variant="secondary" onClick={() => void resetAuto([role().id])}>{t("roles.permission.resetAuto")}</Button>
                                  </div>
                                </Show>
                              </div>
                              <Show when={(role().warnings ?? []).length > 0}>
                                <ul class="roles__warnings" aria-label={t("roles.warnings")}>
                                  <For each={role().warnings}>{(w) => <li><Icon icon={TriangleAlert} size={12} /> {warningText(w)}</li>}</For>
                                </ul>
                              </Show>
                              <label class="roles__field">
                                <span class="roles__label">{t("roles.f.description")}</span>
                                <Input size="sm" aria-label={t("roles.f.description")} disabled={locked()} value={role().description ?? ""} onInput={(e) => edit(role().id, { description: e.currentTarget.value })} />
                              </label>
                              <fieldset class="roles__field">
                                <legend class="roles__label">{t("roles.f.tools")}</legend>
                                <Show when={role().permissionSource === "allTools" && role().tools.length === 0}>
                                  <small class="roles__why">{t("roles.toolsAll")}</small>
                                </Show>
                                <div class="roles__chips" role="group" aria-label={t("roles.f.tools")}>
                                  <For each={toolChips(provider()?.tools ?? [], role().tools)}>
                                    {(tool) => (
                                      <Button size="sm" variant="secondary" class="roles__chip" disabled={locked()} aria-pressed={role().tools.includes(tool)} data-picked={role().tools.includes(tool) ? "" : undefined} onClick={() => edit(role().id, { tools: toggleIn(role().tools, tool) })}>
                                        {tool}
                                      </Button>
                                    )}
                                  </For>
                                </div>
                              </fieldset>
                              <fieldset class="roles__field">
                                <legend class="roles__label">{t("roles.f.color")}</legend>
                                <div class="roles__colors" role="radiogroup" aria-label={t("roles.f.color")}>
                                  <For each={ROLE_COLORS}>
                                    {(c) => <button type="button" role="radio" class="roles__color" disabled={locked()} aria-checked={role().color === c} aria-label={c} style={{ background: c }} onClick={() => edit(role().id, { color: c })} />}
                                  </For>
                                </div>
                              </fieldset>
                              <fieldset class="roles__field">
                                <legend class="roles__label">{t("roles.defaultRepositories")}</legend>
                                <div class="roles__chips" role="group" aria-label={t("roles.defaultRepositories")}>
                                  <For each={repos()}>
                                    {(r) => (
                                      <Button size="sm" variant="secondary" class="roles__chip" disabled={locked()} aria-pressed={(role().defaultRepoIds ?? []).includes(r.id)} data-picked={(role().defaultRepoIds ?? []).includes(r.id) ? "" : undefined} onClick={() => edit(role().id, { defaultRepoIds: toggleIn(role().defaultRepoIds, r.id) })}>
                                        {r.name}
                                      </Button>
                                    )}
                                  </For>
                                </div>
                              </fieldset>
                              <label class="roles__field">
                                <span class="roles__label">{t("roles.f.systemPrompt")}</span>
                                <TextArea aria-label={t("roles.f.systemPrompt")} minRows={2} maxRows={8} disabled={locked()} placeholder={t("roles.placeholderPrompt")} value={role().systemPrompt ?? ""} onInput={(e) => edit(role().id, { systemPrompt: e.currentTarget.value })} />
                              </label>
                              <Show when={group()}>
                                {(g) => (
                                  <section class="roles__copies" aria-label={t("roles.copies.title")}>
                                    <header class="roles__copies-head">
                                      <span class="roles__label">{t("roles.copies.title")}</span>
                                      <span class="roles__why">{winnerReasonText(g().winnerReason)}</span>
                                    </header>
                                    <Show when={g().pinMissing}>
                                      <p class="roles__why" data-tone="warn">{t("roles.pinMissing")}</p>
                                    </Show>
                                    <Show when={g().copies.length > 0} fallback={<p class="roles__why">{t("roles.deleteBuiltinTip")}</p>}>
                                      <ul class="roles__copy-list">
                                        <For each={g().copies}>
                                          {(c) => (
                                            <li class="roles__copy" data-used={c.id === g().winnerId ? "" : undefined}>
                                              <span class="roles__copy-main">
                                                <Badge size="sm" tone={c.scope === "repo" ? "info" : "neutral"}>{c.scope === "repo" ? repoName(c.repoId) : t("roles.scope.global")}</Badge>
                                                <code class="roles__path" title={c.path}>{c.path}</code>
                                              </span>
                                              <span class="roles__copy-state">
                                                <Show when={c.id === g().winnerId}>
                                                  <Badge size="sm" tone="accent">{t("roles.copy.used")}</Badge>
                                                </Show>
                                                <Badge size="sm" tone={c.sameAsWinner ? "ok" : "warn"}>{c.sameAsWinner ? t("roles.copy.identical") : t("roles.copy.differs")}</Badge>
                                                <Show when={c.trust === "untrusted"}>
                                                  <Badge size="sm" tone="warn" icon={ShieldAlert}>{t("roles.trust.untrusted")}</Badge>
                                                </Show>
                                                <Show when={c.trust === "approved"}>
                                                  <Badge size="sm" tone="ok">{t("roles.trust.approved")}</Badge>
                                                </Show>
                                              </span>
                                              <span class="roles__copy-actions">
                                                <Show when={c.trust === "untrusted"}>
                                                  <Button size="sm" variant="secondary" onClick={() => void trust(g(), [c])}>{t("roles.trust.trustButton")}</Button>
                                                </Show>
                                                <Show when={g().pin === pinOf(c)} fallback={<Button size="sm" variant="ghost" onClick={() => void setPin(g(), pinOf(c))}>{t("roles.pin")}</Button>}>
                                                  <Button size="sm" variant="ghost" onClick={() => void setPin(g(), null)}>{t("roles.unpin")}</Button>
                                                </Show>
                                                <Button size="sm" variant="ghost" class="roles__delete" onClick={() => setDeleting({ name: g().name, ids: deleteTargets(g(), c.id) })}>{t("roles.delete")}</Button>
                                              </span>
                                              <Show when={!c.sameAsWinner && fileOf(c.id) && fileOf(g().winnerId)}>
                                                <table class="roles__diff" aria-label={t("roles.copyIn", { repo: repoName(c.repoId) || t("roles.scope.global") })}>
                                                  <thead>
                                                    <tr><th scope="col">{t("roles.diff.field")}</th><th scope="col">{t("roles.diff.used")}</th><th scope="col">{t("roles.diff.copy")}</th></tr>
                                                  </thead>
                                                  <tbody>
                                                    <For each={driftRows(fileOf(g().winnerId)!, fileOf(c.id)!)}>
                                                      {(row) => <tr><th scope="row">{row.label}</th><td data-side="global">{row.global}</td><td data-side="repo">{row.repo}</td></tr>}
                                                    </For>
                                                  </tbody>
                                                </table>
                                              </Show>
                                            </li>
                                          )}
                                        </For>
                                      </ul>
                                      <div class="roles__drift-actions">
                                        <Show when={g().copies.some((c) => !c.sameAsWinner)}>
                                          <Button size="sm" variant="secondary" onClick={() => void makeIdentical(g())}>{t("roles.makeIdentical")}</Button>
                                        </Show>
                                        <Show when={canDelete(g()) && g().copies.length > 1}>
                                          <Button size="sm" variant="ghost" class="roles__delete" onClick={() => setDeleting({ name: g().name, ids: deleteTargets(g()) })}>{t("roles.deleteAll")}</Button>
                                        </Show>
                                      </div>
                                    </Show>
                                  </section>
                                )}
                              </Show>
                            </div>
                          </td>
                        </tr>
                      </Show>
                    </tbody>
                  );
                }}
              </Index>
            </table>
          </div>
          <Show when={view().hiddenCount > 0}>
            <Button size="sm" variant="ghost" class="roles__show-hidden" aria-pressed={showHidden()} onClick={() => setShowHidden(!showHidden())}>
              {showHidden() ? t("roles.hideHiddenAgain") : t("roles.showHidden", { count: view().hiddenCount })}
            </Button>
          </Show>
          <div class="roles__foot">
            <span class="roles__count">{dirty().length === 0 ? t("roles.allSaved") : t("roles.unsaved", { count: dirty().length })}</span>
            <Button size="sm" variant="primary" loading={busy()} disabled={saveable().length === 0} onClick={() => void saveRoles(saveable())}>
              {saveable().length > 1 ? t("roles.saveMany", { count: saveable().length }) : t("roles.save")}
            </Button>
          </div>
          <AutoSettings caps={caps()} version={autoVersion()} />
          <DeleteRoleDialog
            request={deleting()}
            onClose={() => setDeleting(undefined)}
            onDeleted={(report) => {
              setDeleting(undefined);
              toast.success(t("roles.deleted", { count: report.deleted.length }));
              void reload();
            }}
          />
        </Show>
      </Show>
    </div>
  );
}
