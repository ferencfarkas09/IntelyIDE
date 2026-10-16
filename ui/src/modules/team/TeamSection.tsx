import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import type { TeamInvite, TeamMember } from "../../ipc/team";
import { ipc } from "../../ipc";
import type { TeamProject } from "../../ipc/team";
import { Badge, Button, Copy, Dialog, Input, LogOut, ShieldCheck, Spinner, StatusDot, Switch, toast, TriangleAlert, UserMinus, UserPlus, Users } from "../../ui-kit";
import { openSettings } from "../../platform/settings";
import { encodeQr, qrPath } from "../remote/qr";
import { JoinCard } from "./JoinCard";
import { confirmJoin, createTeam, decideJoin, forgetTeam, isRelayOld, leaveTeam, loadError, loaded, loadTeam, messageOf, openInvite, revokeMember, view } from "./store";
import "./team.css";

const sasText = (s: string) => `${s.slice(0, 3)} ${s.slice(3)}`;

/** Settings > Team: create or join a team, invite people with a one-time code, see who is online, revoke, leave. */
export default function TeamSection() {
  onMount(() => void loadTeam());
  return (
    <section class="ui-formgroup team-section">
      <header class="ui-formgroup__head">
        <h4 class="ui-formgroup__title">{t("team.title")} <Badge size="sm" tone="info">{t("team.beta")}</Badge></h4>
        <p class="ui-formgroup__desc">{t("team.desc")}</p>
      </header>
      <div class="team-body">
        <p class="team-note">{t("team.security")}</p>
        <Show when={loadError()}>{(m) => <p class="team-error" role="alert">{m()}</p>}</Show>
        <Show when={view().auditError}>{(m) => <p class="team-warn" role="alert" data-testid="audit-error"><TriangleAlert size={12} /> {t("team.auditError", { reason: m() })}</p>}</Show>
        <Show when={view().error}>{(m) => <p class="team-warn" role="alert" data-testid="team-problem"><TriangleAlert size={12} /> {m()}</p>}</Show>
        <Show when={loaded()}>
          <Show when={view().state === "none"}><Start /></Show>
          <Show when={view().state === "joining"}><Joining /></Show>
          <Show when={view().state === "member"}><Member /></Show>
        </Show>
      </div>
    </section>
  );
}

/** One place that runs a command, shows its failure as text and keeps a busy flag. */
function useAction() {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [relayOld, setRelayOld] = createSignal(false);
  const run = async (f: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(undefined);
    setRelayOld(false);
    try {
      await f();
      return true;
    } catch (e) {
      setError(messageOf(e));
      setRelayOld(isRelayOld(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, relayOld, run, setError };
}

function Start() {
  const [name, setName] = createSignal("");
  const create = useAction();
  return (
    <div class="team-start">
      <div class="team-card">
        <h5 class="team-card__title">{t("team.create.title")}</h5>
        <p class="team-note">{t("team.create.body")}</p>
        <Input size="sm" aria-label={t("team.name.label")} placeholder={t("team.name.ph")} maxLength={60} value={name()} onInput={(e) => setName(e.currentTarget.value)} />
        <div class="team-actions">
          <Button size="sm" variant="primary" icon={Users} loading={create.busy()} disabled={!name().trim()} onClick={() => void create.run(() => createTeam(name()))}>
            {t("team.create.go")}
          </Button>
        </div>
        <Show when={create.error()}>{(m) => <p class="team-error" role="alert">{m()}</p>}</Show>
        <Show when={create.relayOld()}><Button size="sm" variant="secondary" onClick={() => openSettings("remote")}>{t("team.err.openRemote")}</Button></Show>
      </div>
      <JoinCard name={name()} onName={setName} />
    </div>
  );
}

/** The joiner's wait: connecting, then the six digits to compare with the admin's screen. */
function Joining() {
  const act = useAction();
  const j = () => view().joining;
  return (
    <div class="team-card" data-testid="joining">
      <h5 class="team-card__title">{t("team.joining.title")}</h5>
      <Show
        when={j()?.stage === "confirm" && j()?.sas}
        fallback={
          <p class="team-wait">
            <Spinner size={14} />
            {j()?.stage === "waitingWelcome" ? t("team.joining.welcome") : j()?.stage === "waitingAdmin" ? t("team.joining.admin") : t("team.joining.connecting")}
          </p>
        }
      >
        {(sas) => (
          <>
            <p class="team-note">{t("team.joining.compare")}</p>
            <p class="team-sas" data-testid="sas">{sasText(sas())}</p>
            <div class="team-actions">
              <Button size="sm" variant="secondary" disabled={act.busy()} onClick={() => void act.run(() => confirmJoin(false))}>
                {t("team.sas.mismatch")}
              </Button>
              <Button size="sm" variant="primary" icon={ShieldCheck} loading={act.busy()} onClick={() => void act.run(() => confirmJoin(true))}>
                {t("team.sas.match")}
              </Button>
            </div>
          </>
        )}
      </Show>
      <Show when={view().joining && j()?.stage !== "confirm"}>
        <div class="team-actions">
          <Button size="sm" variant="ghost" onClick={() => void act.run(() => confirmJoin(false))}>{t("team.joining.cancel")}</Button>
        </div>
      </Show>
      <Show when={act.error()}>{(m) => <p class="team-error" role="alert">{m()}</p>}</Show>
    </div>
  );
}

function Member() {
  const [trusted, setTrusted] = createSignal<string[]>([]);
  onMount(() => void ipc.team.collabSettings().then((c) => setTrusted(c.autoAcceptNotesFrom), () => undefined));
  const setTrust = (id: string, on: boolean) => {
    setTrusted((all) => [...all.filter((x) => x !== id), ...(on ? [id] : [])]);
    ipc.team.setAutoAccept(id, on).catch((e) => ipc.team.collabSettings().then((c) => setTrusted(c.autoAcceptNotesFrom), () => undefined).then(() => toast.error(messageOf(e))));
  };
  const isAdmin = () => view().role === "admin";
  const [inviting, setInviting] = createSignal(false);
  const [revoking, setRevoking] = createSignal<TeamMember | undefined>(undefined);
  const [leaving, setLeaving] = createSignal(false);
  const revoke = useAction();
  const leave = useAction();
  const decide = useAction();

  const doRevoke = async () => {
    const m = revoking();
    if (m && (await revoke.run(() => revokeMember(m.id)))) {
      setRevoking(undefined);
      toast.success(t("team.revoked", { name: m.name }));
    }
  };
  const doLeave = async () => {
    if (await leave.run(() => leaveTeam())) setLeaving(false);
  };
  const online = createMemo(() => view().members.filter((m) => m.online).length);

  return (
    <div class="team-member">
      <div class="team-head">
        <StatusDot tone={view().connected ? "ok" : "neutral"} label={view().connected ? t("team.connected") : t("team.offline")} />
        <span class="team-head__state">{view().connected ? t("team.connected") : t("team.offline")}</span>
        <Badge tone="neutral" size="sm">{t("team.epoch", { n: view().epoch })}</Badge>
        <span class="team-head__grow" />
        <span class="team-note">{t("team.onlineCount", { online: online(), total: view().members.length })}</span>
      </div>

      <Show when={view().removed}>
        <div class="team-card team-card--ask" role="group" aria-label={t("team.removed.title")} data-testid="removed">
          <h5 class="team-card__title">{t("team.removed.title")}</h5>
          <p class="team-note">{t("team.removed.body")}</p>
          <div class="team-actions">
            <Button size="sm" variant="danger" loading={leave.busy()} onClick={() => void leave.run(() => forgetTeam())}>{t("team.removed.forget")}</Button>
          </div>
          <Show when={leave.error()}>{(m) => <p class="team-error" role="alert">{m()}</p>}</Show>
        </div>
      </Show>

      <Show when={view().joinRequest}>
        {(r) => (
          <div class="team-card team-card--ask" role="group" aria-label={t("team.request.title", { name: r().name })} data-testid="join-request">
            <h5 class="team-card__title">{t("team.request.title", { name: r().name })}</h5>
            <p class="team-note">{t("team.request.compare")}</p>
            <p class="team-sas" data-testid="sas">{sasText(r().sas)}</p>
            <div class="team-actions">
              <Button size="sm" variant="secondary" disabled={decide.busy()} onClick={() => void decide.run(() => decideJoin(false))}>{t("team.sas.mismatch")}</Button>
              <Button size="sm" variant="primary" icon={ShieldCheck} loading={decide.busy()} onClick={() => void decide.run(() => decideJoin(true))}>{t("team.request.accept")}</Button>
            </div>
            <Show when={decide.error()}>{(m) => <p class="team-error" role="alert">{m()}</p>}</Show>
          </div>
        )}
      </Show>

      <ul class="team-members" aria-label={t("team.members")}>
        <For each={view().members}>
          {(m) => (
            <li class="team-row" aria-label={m.name}>
              <StatusDot tone={m.online ? "ok" : "neutral"} label={m.online ? t("team.member.online") : t("team.member.offline")} />
              <span class="team-row__name">{m.name}</span>
              <Show when={m.me}><Badge tone="accent" size="sm">{t("team.member.you")}</Badge></Show>
              <Badge tone={m.role === "admin" ? "info" : "neutral"} size="sm">{m.role === "admin" ? t("team.role.admin") : t("team.role.member")}</Badge>
              <Show when={m.state}><span class="team-row__state">{m.state}</span></Show>
              <span class="team-row__grow" />
              <span class="team-row__presence">{m.online ? t("team.member.online") : t("team.member.offline")}</span>
              <Show when={!m.me}>
                <span class="team-row__trust" title={t("team.note.autoTip")}>
                  <Switch size="sm" checked={trusted().includes(m.id)} onChange={(next) => setTrust(m.id, next)} aria-label={t("team.note.autoAria", { name: m.name })} label={t("team.note.auto")} />
                </span>
              </Show>
              <Show when={isAdmin() && !m.me && m.role !== "admin"}>
                <Button size="sm" variant="ghost" icon={UserMinus} onClick={() => (revoke.setError(undefined), setRevoking(m))} aria-label={t("team.revoke.aria", { name: m.name })}>
                  {t("team.revoke")}
                </Button>
              </Show>
            </li>
          )}
        </For>
      </ul>

      <SharedProjects />

      <div class="team-actions">
        <Show when={isAdmin()}>
          <Button size="sm" variant="secondary" icon={UserPlus} onClick={() => setInviting(true)}>{t("team.invite")}</Button>
        </Show>
        <span class="team-row__grow" />
        <Button size="sm" variant="ghost" icon={LogOut} onClick={() => (leave.setError(undefined), setLeaving(true))}>{t("team.leave")}</Button>
      </div>
      <p class="team-note">{t("team.relayLine", { relay: view().relay })}</p>

      <InviteDialog open={inviting()} onClose={() => setInviting(false)} />

      <Dialog
        open={!!revoking()}
        onClose={() => setRevoking(undefined)}
        role="alertdialog"
        size="sm"
        title={t("team.revoke.title", { name: revoking()?.name ?? "" })}
        description={t("team.revoke.body")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevoking(undefined)}>{t("team.cancel")}</Button>
            <Button variant="danger" loading={revoke.busy()} onClick={() => void doRevoke()}>{t("team.revoke")}</Button>
          </>
        }
      >
        <Show when={revoke.error()}>{(m) => <p class="team-error" role="alert">{m()}</p>}</Show>
      </Dialog>

      <Dialog
        open={leaving()}
        onClose={() => setLeaving(false)}
        role="alertdialog"
        size="sm"
        title={t("team.leave.title")}
        description={isAdmin() ? t("team.leave.bodyAdmin") : t("team.leave.body")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setLeaving(false)}>{t("team.cancel")}</Button>
            <Button variant="danger" loading={leave.busy()} onClick={() => void doLeave()}>{t("team.leave")}</Button>
          </>
        }
      >
        <Show when={leave.error()}>{(m) => <p class="team-error" role="alert">{m()}</p>}</Show>
      </Dialog>
    </div>
  );
}

/** The code and the QR of a one-time invite. It is made when the dialog opens and counts down. */
function InviteDialog(props: { open: boolean; onClose: () => void }) {
  const [invite, setInvite] = createSignal<TeamInvite | undefined>(undefined);
  const [now, setNow] = createSignal(Date.now());
  const act = useAction();
  const start = async () => {
    setInvite(undefined);
    await act.run(async () => setInvite(await openInvite()));
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  onMount(() => (timer = setInterval(() => setNow(Date.now()), 1000)));
  onCleanup(() => timer && clearInterval(timer));
  createEffect(on(() => props.open, (open) => (open ? void start() : setInvite(undefined)), { defer: true }));
  // somebody asked in: the request card takes over
  createEffect(() => view().joinRequest && props.open && props.onClose());

  const qr = createMemo(() => {
    const i = invite();
    if (!i) return null;
    try {
      return qrPath(encodeQr(i.qr));
    } catch {
      return null;
    }
  });
  const left = () => Math.max(0, Math.ceil(((invite()?.expiresAt ?? 0) - now()) / 1000));
  const expired = () => !!invite() && left() === 0;
  const clock = () => `${Math.floor(left() / 60)}:${String(left() % 60).padStart(2, "0")}`;

  return (
    <Dialog open={props.open} onClose={props.onClose} title={t("team.invite.title")} size="md" closeOnBackdrop={false} footer={<Button variant="secondary" onClick={props.onClose}>{t("team.invite.close")}</Button>}>
      <div class="team-invite">
        <Show when={invite()} fallback={<p class="team-note">{act.busy() ? t("team.invite.preparing") : ""}</p>}>
          {(i) => (
            <>
              <p class="team-note">{t("team.invite.body")}</p>
              <div class="team-invite__qr">
                <Show when={qr()} fallback={<p class="team-note">{t("team.invite.tooLong")}</p>}>
                  {(q) => (
                    <svg viewBox={`0 0 ${q().size} ${q().size}`} role="img" aria-label={t("team.invite.qr")} class="team-qr" shape-rendering="crispEdges">
                      <rect width={q().size} height={q().size} fill="#fff" />
                      <path d={q().d} fill="#000" />
                    </svg>
                  )}
                </Show>
                <div class="team-invite__side">
                  <p class="team-label">{t("team.invite.codeLabel")}</p>
                  <p class="team-code" data-testid="invite-code">{i().code}</p>
                  <Button size="sm" icon={Copy} onClick={() => void navigator.clipboard?.writeText(i().code).then(() => toast.info(t("team.invite.copied")))}>{t("team.invite.copy")}</Button>
                  <Show when={!expired()} fallback={<Button size="sm" variant="primary" onClick={() => void start()}>{t("team.invite.new")}</Button>}>
                    <p class="team-note" data-testid="countdown">{t("team.invite.valid", { time: clock() })}</p>
                  </Show>
                </div>
              </div>
              <p class="team-note"><TriangleAlert size={12} /> {t("team.invite.once")}</p>
            </>
          )}
        </Show>
        <Show when={act.error()}>{(m) => <p class="team-error" role="alert">{m()}</p>}</Show>
      </div>
    </Dialog>
  );
}

/** Which open projects are shared with the team. A project is identified by its `git remote origin`, so a folder without one cannot be shared. */
function SharedProjects() {
  const [projects, setProjects] = createSignal<TeamProject[]>([]);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const load = () => ipc.team.projects().then((p) => (setProjects(p), setError(undefined)), (e) => setError(messageOf(e)));
  onMount(() => void load());
  const toggle = (p: TeamProject, shared: boolean) => {
    if (!p.key) return;
    setProjects((all) => all.map((x) => (x.key === p.key ? { ...x, shared } : x)));
    ipc.team.setShare(p.key, shared).catch((e) => (setError(messageOf(e)), void load()));
  };
  const toggleWorkspace = (p: TeamProject, workspace: boolean) => {
    if (!p.key) return;
    setProjects((all) => all.map((x) => (x.key === p.key ? { ...x, workspace } : x)));
    ipc.team.setWorkspace(p.key, workspace).catch((e) => (setError(messageOf(e)), void load()));
  };
  const toggleMemory = (p: TeamProject, memory: boolean) => {
    if (!p.key) return;
    setProjects((all) => all.map((x) => (x.key === p.key ? { ...x, memory } : x)));
    ipc.team.setMemory(p.key, memory).catch((e) => (setError(messageOf(e)), void load()));
  };
  const toggleClaudeMd = (p: TeamProject, claudeMd: boolean) => {
    if (!p.key) return;
    setProjects((all) => all.map((x) => (x.key === p.key ? { ...x, claudeMd } : x)));
    ipc.team.setClaudeMd(p.key, claudeMd).catch((e) => (setError(messageOf(e)), void load()));
  };
  return (
    <div class="team-share" data-testid="shared-projects">
      <h5 class="team-card__title">{t("team.share.title")}</h5>
      <p class="team-note">{t("team.share.body")}</p>
      <p class="team-note">{t("team.ws.settingBody")}</p>
      <p class="team-note">{t("team.mem.settingBody")}</p>
      <p class="team-note team-note--warn"><TriangleAlert size={14} /> <span>{t("team.mem.claudeMdWarn")}</span></p>
      <Show when={error()}>{(m) => <p class="team-error" role="alert">{m()}</p>}</Show>
      <Show when={projects().length > 0} fallback={<p class="team-note">{t("team.share.none")}</p>}>
        <ul class="team-members" aria-label={t("team.share.title")}>
          <For each={projects()}>
            {(p) => (
              <li class="team-row">
                <span class="team-row__name">{p.name}</span>
                <Show when={!p.key}><span class="team-row__state">{t("team.share.noOrigin")}</span></Show>
                <span class="team-row__grow" />
                <span class="team-row__switches">
                  <Switch size="sm" checked={p.shared} disabled={!p.key} onChange={(next) => toggle(p, next)} aria-label={t("team.share.toggle", { name: p.name })} label={p.shared ? t("team.share.on") : t("team.share.off")} />
                  <Switch size="sm" checked={p.workspace} disabled={!p.key} onChange={(next) => toggleWorkspace(p, next)} aria-label={t("team.ws.toggle", { name: p.name })} label={p.workspace ? t("team.ws.on") : t("team.ws.off")} />
                  <Switch size="sm" checked={p.memory} disabled={!p.key} onChange={(next) => toggleMemory(p, next)} aria-label={t("team.mem.toggle", { name: p.name })} label={p.memory ? t("team.mem.on") : t("team.mem.off")} />
                  <Switch size="sm" checked={p.claudeMd} disabled={!p.key || !p.memory} onChange={(next) => toggleClaudeMd(p, next)} aria-label={t("team.mem.claudeMdToggle", { name: p.name })} label={p.claudeMd ? t("team.mem.claudeMdOn") : t("team.mem.claudeMdOff")} />
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
