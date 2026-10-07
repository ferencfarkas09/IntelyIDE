import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { AiMode, DialogHandle, LocalHit, ProfileView } from "../../ipc/mongo";
import { Badge, Button, ChevronDown, ChevronRight, Copy, Database, Dialog, Download, Ellipsis, EmptyState, EnvPill, FolderPlus, IconButton, Input, Lock, Menu, Pencil, Plug, Plus, Search, SegmentedControl, Server, Skeleton, Sparkles, ShieldAlert, StatusDot, toast, Trash2, TriangleAlert, Unplug, Upload } from "../../ui-kit";
import { ConnectionForm } from "./ConnectionForm";
import { StarToggle } from "./form/fields";
import { clearLost, expectClose, lostConnections, studioSnapshot, type ConnectionsAction } from "./gate";
import { ExportDialog, ImportDialog, ioErrorText } from "./ImportExportDialog";
import { isDangerous, levelNote, roleView, shownEnv, type StartingPoint } from "./logic";
import { ProductionBar, TlsChips } from "./loudChip";
import { createConnector } from "./onboarding/connector";
import { FirstRun } from "./onboarding/FirstRun";
import { allGroups, chipsOf, sectionsOf, toggled, type TagFilter } from "./onboarding/logic";
import { patchPrefs, readPrefs, type MongoPrefs } from "./onboarding/prefs";
import { Wizard } from "./onboarding/Wizard";
import { disconnect, dropProfile, loaded, loadError, messageOf, profiles, refreshProfiles, stateOf } from "./store";
import "./manage.css";

export interface ConnectionManagerProps {
  /** Compact list rows for the Settings section; cards for the tab. */
  compact?: boolean;
  defaultAi: AiMode;
  /** A palette command asked for something; the nonce makes the same action repeatable. */
  action?: { action: ConnectionsAction; nonce: number };
  /** Called after a successful connect from a card. */
  onConnected?: (p: ProfileView) => void;
}

const aiLabel = (p: ProfileView) => (p.aiMode === "off" ? t("mongoManage.card.aiOff") : p.aiMode === "schemaEnums" ? t("mongoManage.card.aiEnums") : t("mongoManage.card.aiSchema"));

interface CardProps {
  p: ProfileView;
  compact?: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMove: () => void;
  onExport: () => void;
  onFavorite: (v: boolean) => void;
}

function Card(props: CardProps) {
  const st = () => stateOf(props.p.id);
  const dangerous = () => isDangerous(props.p);
  const role = () => roleView(st().view?.role);
  const chips = () => chipsOf(props.p);
  const lost = () => lostConnections()[props.p.id];
  const dotState = () => (st().status === "connected" ? "ok" : st().status === "error" ? "danger" : st().status === "connecting" ? "info" : "neutral");
  const statusText = () =>
    st().status === "connected" ? t("mongoManage.card.connected") : st().status === "connecting" ? t("mongoManage.card.connecting") : st().status === "error" ? t("mongoManage.card.failed") : props.p.hasUri ? t("mongoManage.card.idle") : t("mongoManage.card.noUri");
  const tunnelState = () => st().view?.tunnel ?? undefined;
  return (
    <article class="mg-card" data-compact={props.compact ? "" : undefined} data-danger={dangerous() ? "" : undefined} style={{ "--edge": props.p.color ?? "var(--border-strong)" }} aria-label={props.p.name}>
      <Show when={st().status === "connected" && dangerous()}><ProductionBar profile={props.p} /></Show>
      <div class="mg-card__top">
        <Database size={16} class="mg-card__icon" aria-hidden="true" />
        <h3 class="mg-card__name ui-truncate">{props.p.name}</h3>
        <StarToggle on={props.p.favorite} onChange={props.onFavorite} label={props.p.favorite ? t("mongoForm.favorite.on") : t("mongoForm.favorite.off")} />
        <EnvPill env={shownEnv(props.p)} size="sm" />
      </div>
      <p class="mg-card__host ui-mono ui-truncate" title={props.p.host} dir="ltr"><Server size={12} aria-hidden="true" /> {props.p.host}</p>
      <div class="mg-card__chips">
        <span class="mg-status"><StatusDot tone={dotState()} pulse={st().status === "connecting"} /><span>{statusText()}</span></span>
        <Badge size="sm" icon={Lock} title={t("mongoManage.card.readOnlyTitle")}>{t("mongoManage.card.readOnly")}</Badge>
        <Show when={st().status === "connected"}>
          <Badge size="sm" tone={role().tone} title={role().detail}>{role().label}</Badge>
        </Show>
        <Show when={chips().tunnel}>
          {(k) => (
            <Badge size="sm" tone={tunnelState() === "down" ? "danger" : tunnelState() === "up" ? "ok" : "neutral"} icon={Plug} title={t("mongoManage.chip.tunnel.title")}>
              {k() === "ssh" ? t("mongoManage.chip.ssh") : t("mongoManage.chip.proxy")}
              {tunnelState() ? ` · ${t(tunnelState() === "up" ? "mongoManage.chip.up" : "mongoManage.chip.down")}` : ""}
            </Badge>
          )}
        </Show>
        <Show when={st().status === "connected" ? st().view?.tls : chips().tls === "on" || props.p.spec?.scheme === "srv"}>
          <Badge size="sm" icon={Lock} title={t("mongoManage.chip.tls.title")}>{t("mongoManage.chip.tls")}</Badge>
        </Show>
        <TlsChips profile={props.p} />
        <Show when={chips().preset === "happy"}><Badge size="sm" tone="accent" title={t("mongoManage.chip.preset.title")}>{t("mongoManage.chip.preset")}</Badge></Show>
        <Show when={props.p.effectiveLevel === "productionLevel" && props.p.environment !== "production"}>
          <Badge size="sm" tone="danger" title={levelNote(props.p)}>{t("mongoManage.chip.productionLevel")}</Badge>
        </Show>
        <Show when={props.p.levelOverride}><Badge size="sm" tone="warn" title={levelNote(props.p)}>{t("mongoManage.chip.lowered")}</Badge></Show>
        <Show when={props.p.needsReview}><Badge size="sm" tone="warn" icon={TriangleAlert} title={t("mongoManage.chip.review.title")}>{t("mongoManage.chip.review")}</Badge></Show>
        <Show when={props.p.legacyUri}><Badge size="sm" title={t("mongoManage.chip.legacy.title")}>{t("mongoManage.chip.legacy")}</Badge></Show>
        <Badge size="sm" tone={props.p.aiMode !== "off" ? "accent" : "neutral"} icon={Sparkles}>{aiLabel(props.p)}</Badge>
      </div>
      <Show when={lost() && st().status !== "connected"}>
        <div class="mm-banner" data-tone="danger" role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          <span>{lost()!.tunnel ? t("mongoManage.lost.tunnel", { name: props.p.name }) : t("mongoManage.lost.body", { name: props.p.name })}</span>
          <Button size="sm" variant="secondary" onClick={props.onConnect}>{t("mongoManage.lost.reconnect")}</Button>
          <Button size="sm" variant="ghost" onClick={() => clearLost(props.p.id)}>{t("mongoManage.dismiss")}</Button>
        </div>
      </Show>
      <Show when={st().status === "error"}><p class="mg-card__error" role="alert">{st().error}</p></Show>
      <Show when={props.p.needsReview}><p class="mm-hint">{t("mongoManage.card.needsReview")}</p></Show>
      <div class="mg-card__actions">
        <Button
          size="sm"
          variant={st().status === "connected" ? "secondary" : "primary"}
          icon={st().status === "connected" ? Unplug : Plug}
          loading={st().status === "connecting"}
          disabled={(!props.p.hasUri && st().status !== "connected") || (props.p.needsReview && st().status !== "connected")}
          onClick={() => (st().status === "connected" ? props.onDisconnect() : props.onConnect())}
        >
          {st().status === "connected" ? t("mongoManage.card.disconnect") : t("mongoManage.card.connect")}
        </Button>
        <IconButton icon={Pencil} label={t("mongoManage.card.edit")} size="sm" onClick={props.onEdit} />
        <IconButton icon={Copy} label={t("mongoManage.card.duplicate")} size="sm" onClick={props.onDuplicate} />
        <Menu
          aria-label={t("mongoManage.card.moreFor", { name: props.p.name })}
          placement="bottom-end"
          trigger={(tr) => <IconButton {...tr} icon={Ellipsis} label={t("mongoManage.card.more")} size="sm" />}
          items={[
            { label: t("mongoManage.card.copyHost"), icon: Copy, onSelect: () => void navigator.clipboard?.writeText(props.p.host).then(() => toast.info(t("mongoManage.card.hostCopied"))) },
            { label: t("mongoManage.card.move"), icon: FolderPlus, onSelect: props.onMove },
            { label: t("mongoManage.card.export"), icon: Upload, onSelect: props.onExport },
            { type: "separator" },
            { label: t("mongoManage.card.delete"), icon: Trash2, danger: true, onSelect: props.onDelete },
          ]}
        />
      </div>
    </article>
  );
}

/**
 * Connection profiles as cards (or compact rows): favourites on top, then groups, search and a tag filter; the first-run tiles and the
 * wizard when there is nothing yet; import and export; the connect flow with its confirmations and the password prompt.
 */
export function ConnectionManager(props: ConnectionManagerProps) {
  const [query, setQuery] = createSignal("");
  const [tag, setTag] = createSignal<TagFilter>("all");
  const [prefs, setPrefs] = createSignal<MongoPrefs>({ defaultAi: props.defaultAi, happyPreset: false, onboardingDone: false, groupsCollapsed: [] });
  const [prefsLoaded, setPrefsLoaded] = createSignal(false);
  const [form, setForm] = createSignal<{ profile?: ProfileView } | null>(null);
  const [wizard, setWizard] = createSignal<{ kind?: StartingPoint; hit?: LocalHit } | null>(null);
  const [removing, setRemoving] = createSignal<ProfileView>();
  const [moving, setMoving] = createSignal<ProfileView>();
  const [exporting, setExporting] = createSignal<{ preselect: string[] } | null>(null);
  const [importing, setImporting] = createSignal<DialogHandle | null>(null);
  const connector = createConnector({ onConnected: (p) => props.onConnected?.(p) });

  onMount(() => {
    void refreshProfiles();
    void readPrefs().then(setPrefs).catch(() => undefined).finally(() => setPrefsLoaded(true));
  });

  const sections = createMemo(() => sectionsOf(profiles(), { query: query(), tag: tag() }));
  const groups = createMemo(() => allGroups(profiles()));
  const showFirst = () => loaded() && !loadError() && prefsLoaded() && profiles().length === 0 && !prefs().onboardingDone;

  async function markOnboarded() {
    if (prefs().onboardingDone) return;
    setPrefs((p) => ({ ...p, onboardingDone: true }));
    await patchPrefs({ onboardingDone: true }).catch(() => undefined);
  }
  const saved = () => (void markOnboarded(), void refreshProfiles());

  async function startImport() {
    try {
      const h = await ipc.mongo.dialogOpen("import");
      if (h) setImporting(h);
    } catch (e) {
      toast.error(t("mongoManage.io.failedTitle"), ioErrorText(e));
    }
  }

  // Palette commands open things through the tab's params: once when the tab mounts with them, again whenever the nonce changes.
  const doAction = (a: ConnectionsAction | undefined) => {
    if (a === "new") setForm({});
    else if (a === "wizard") setWizard({});
    else if (a === "import") void startImport();
    else if (a === "export") setExporting({ preselect: [] });
  };
  onMount(() => doAction(props.action?.action));
  createEffect(on(() => props.action?.nonce, () => doAction(props.action?.action), { defer: true }));

  async function duplicate(p: ProfileView) {
    try {
      const copy = await ipc.mongo.profileDuplicate(p.id);
      await refreshProfiles();
      setForm({ profile: copy });
    } catch (e) {
      toast.error(t("mongoManage.dup.failed"), messageOf(e));
    }
  }

  async function remove(p: ProfileView) {
    try {
      expectClose(p.id);
      await disconnect(p.id).catch(() => undefined);
      await ipc.mongo.profileDelete(p.id);
      dropProfile(p.id);
      toast.success(t("mongoManage.delete.done", { name: p.name }));
    } catch (e) {
      toast.error(t("mongoManage.delete.failed"), messageOf(e));
    } finally {
      setRemoving(undefined);
    }
  }

  async function favorite(p: ProfileView, v: boolean) {
    try {
      await ipc.mongo.profileMeta(p.id, { favorite: v });
      await refreshProfiles();
    } catch (e) {
      toast.error(t("mongoManage.meta.failed"), messageOf(e));
    }
  }

  async function moveTo(p: ProfileView, group: string) {
    try {
      await ipc.mongo.profileMeta(p.id, { group: group.trim().slice(0, 40) });
      await refreshProfiles();
      setMoving(undefined);
    } catch (e) {
      toast.error(t("mongoManage.meta.failed"), messageOf(e));
    }
  }

  async function toggleSection(key: string) {
    const next = toggled(prefs().groupsCollapsed, key);
    setPrefs((p) => ({ ...p, groupsCollapsed: next }));
    await patchPrefs({ groupsCollapsed: next }).catch(() => undefined);
  }

  const sectionTitle = (s: { kind: string; group?: string }) => (s.kind === "favorites" ? t("mongoManage.group.favorites") : s.kind === "none" ? t("mongoManage.group.none") : (s.group ?? ""));
  const disconnectOne = async (p: ProfileView) => {
    expectClose(p.id);
    await disconnect(p.id);
  };

  return (
    <div class="mg-manager" data-compact={props.compact ? "" : undefined}>
      <div class="mg-manager__bar">
        <Show when={profiles().length > 0}>
          <Input size="sm" aria-label={t("mongoManage.search.aria")} placeholder={t("mongoManage.search.placeholder")} value={query()} onInput={(e) => setQuery(e.currentTarget.value)} leading={<Search size={14} />} wrapperClass="mg-manager__search" />
        </Show>
        <Show when={profiles().length > 1}>
          <SegmentedControl
            aria-label={t("mongoManage.filter.aria")}
            size="sm"
            value={tag()}
            onChange={setTag}
            options={[
              { value: "all", label: t("mongoManage.filter.all") },
              { value: "local", label: t("mongoForm.env.local") },
              { value: "sandbox", label: t("mongoForm.env.sandbox") },
              { value: "production", label: t("mongoForm.env.production") },
            ]}
          />
        </Show>
        <span class="mm-grow" />
        <Show when={profiles().length > 0}>
          <Button size="sm" variant="ghost" icon={Download} onClick={() => void startImport()}>{t("mongoManage.import.open")}</Button>
          <Button size="sm" variant="ghost" icon={Upload} onClick={() => setExporting({ preselect: [] })}>{t("mongoManage.export.open")}</Button>
        </Show>
        <Show when={profiles().length === 0 && loaded() && !loadError()}>
          <Button size="sm" variant="ghost" icon={Download} onClick={() => void startImport()}>{t("mongoManage.import.open")}</Button>
        </Show>
        <Button size="sm" variant="primary" icon={Plus} onClick={() => setForm({})}>{t("mongoManage.new")}</Button>
      </div>

      <Show when={studioSnapshot()?.network === "refused"}>
        <p class="mm-banner" data-tone="warn" role="status"><TriangleAlert size={14} aria-hidden="true" /> <span>{t("mongoManage.network.refused")}</span></p>
      </Show>
      <Show when={studioSnapshot()?.network === "loopbackOnly"}>
        <p class="mm-banner" data-tone="info" role="status"><TriangleAlert size={14} aria-hidden="true" /> <span>{t("mongoManage.network.loopback")}</span></p>
      </Show>
      <For each={studioSnapshot()?.notices ?? []}>
        {(n) => (
          <p class="mm-banner" data-tone="warn" role="status">
            <ShieldAlert size={14} aria-hidden="true" /> <span>{n.message}</span>
            <Button size="sm" variant="ghost" onClick={() => void ipc.mongo.dismissNotices()}>{t("mongoManage.dismiss")}</Button>
          </p>
        )}
      </For>

      <Show when={loaded()} fallback={<div class="mg-manager__grid" aria-busy="true"><Skeleton height={120} /><Skeleton height={120} /></div>}>
        <Show when={!loadError()} fallback={<EmptyState tone="danger" icon={Database} title={t("mongoManage.error.title")} description={loadError()} action={<Button size="sm" onClick={() => void refreshProfiles()}>{t("mongoManage.retry")}</Button>} />}>
          <Show
            when={profiles().length > 0}
            fallback={
              <Show
                when={showFirst()}
                fallback={
                  <EmptyState
                    icon={Database}
                    title={t("mongoManage.empty.title")}
                    description={t("mongoManage.empty.body")}
                    action={
                      <div class="mm-actions">
                        <Button variant="primary" icon={Plus} onClick={() => setForm({})}>{t("mongoManage.new")}</Button>
                        <Button variant="secondary" onClick={() => setWizard({})}>{t("mongoManage.guide")}</Button>
                      </div>
                    }
                  />
                }
              >
                <FirstRun onPick={(kind, hit) => setWizard({ kind, hit })} onDismiss={() => void markOnboarded()} />
              </Show>
            }
          >
            <Show when={sections().length > 0} fallback={<EmptyState size="sm" icon={Search} title={t("mongoManage.nomatch.title")} description={query().trim() ? t("mongoManage.nomatch.body", { query: query() }) : t("mongoManage.nomatch.tag")} />}>
              <For each={sections()}>
                {(s) => {
                  const open = () => !prefs().groupsCollapsed.includes(s.key) || !!query().trim();
                  return (
                    <section class="mm-section" aria-label={sectionTitle(s)}>
                      <Show when={s.kind !== "none" || sections().length > 1}>
                        <h4 class="mm-section__head">
                          <button type="button" class="mm-section__btn" aria-expanded={open()} onClick={() => void toggleSection(s.key)}>
                            {open() ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                            <span>{sectionTitle(s)}</span>
                            <span class="mm-section__n">{s.items.length}</span>
                          </button>
                        </h4>
                      </Show>
                      <Show when={open()}>
                        <div class="mg-manager__grid">
                          <For each={s.items}>
                            {(p) => (
                              <Card
                                p={p}
                                compact={props.compact}
                                onConnect={() => void connector.start(p)}
                                onDisconnect={() => void disconnectOne(p)}
                                onEdit={() => setForm({ profile: p })}
                                onDuplicate={() => void duplicate(p)}
                                onDelete={() => setRemoving(p)}
                                onMove={() => setMoving(p)}
                                onExport={() => setExporting({ preselect: [p.id] })}
                                onFavorite={(v) => void favorite(p, v)}
                              />
                            )}
                          </For>
                        </div>
                      </Show>
                    </section>
                  );
                }}
              </For>
            </Show>
          </Show>
        </Show>
      </Show>

      {connector.dialogs()}

      <Show when={form()} keyed>
        {(f) => <ConnectionForm profile={f.profile} defaultAi={props.defaultAi} happyPreset={prefs().happyPreset} onClose={() => setForm(null)} onSaved={saved} />}
      </Show>
      <Show when={wizard()} keyed>
        {(w) => (
          <Wizard
            kind={w.kind}
            hit={w.hit}
            defaultAi={props.defaultAi}
            happyPreset={prefs().happyPreset}
            onClose={() => setWizard(null)}
            onSaved={saved}
            onConnect={(p) => void connector.start(p)}
          />
        )}
      </Show>
      <Show when={exporting()} keyed>
        {(e) => <ExportDialog profiles={profiles()} preselect={e.preselect} onClose={() => setExporting(null)} />}
      </Show>
      <Show when={importing()} keyed>
        {(h) => <ImportDialog handle={h} onClose={() => setImporting(null)} onImported={() => void markOnboarded()} />}
      </Show>
      <Show when={moving()} keyed>
        {(p) => <MoveDialog profile={p} groups={groups()} onSave={(g) => void moveTo(p, g)} onClose={() => setMoving(undefined)} />}
      </Show>
      <Show when={removing()} keyed>
        {(p) => (
          <Dialog open role="alertdialog" size="sm" onClose={() => setRemoving(undefined)} title={t("mongoManage.delete.title", { name: p.name })} description={t("mongoManage.delete.body")}
            footer={<><Button variant="ghost" onClick={() => setRemoving(undefined)}>{t("mongoManage.delete.keep")}</Button><Button variant="danger" data-autofocus onClick={() => void remove(p)}>{t("mongoManage.delete.confirm")}</Button></>}
          >
            <p class="ui-text-2">{t("mongoManage.delete.note")}</p>
          </Dialog>
        )}
      </Show>
    </div>
  );
}

/** "Move to group...": one level, at most 40 characters; an empty name takes the connection out of its group. */
function MoveDialog(props: { profile: ProfileView; groups: string[]; onSave: (group: string) => void; onClose: () => void }) {
  const [value, setValue] = createSignal(props.profile.group ?? "");
  const save = () => props.onSave(value());
  return (
    <Dialog open size="sm" onClose={props.onClose} title={t("mongoManage.move.title", { name: props.profile.name })} description={t("mongoManage.move.body")}
      footer={<><Button variant="ghost" onClick={props.onClose}>{t("mongoManage.cancel")}</Button><Button variant="primary" onClick={save}>{t("mongoManage.move.save")}</Button></>}
    >
      <form onSubmit={(e) => (e.preventDefault(), save())} class="mm-field">
        <label class="mm-field__label" for="mm-move-group">{t("mongoForm.group.label")}</label>
        <Input id="mm-move-group" list="mm-move-groups" maxlength={40} autocomplete="off" data-autofocus placeholder={t("mongoForm.group.placeholder")} value={value()} onInput={(e) => setValue(e.currentTarget.value.slice(0, 40))} />
        <datalist id="mm-move-groups"><For each={props.groups}>{(g) => <option value={g} />}</For></datalist>
      </form>
    </Dialog>
  );
}
