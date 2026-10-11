import { createEffect, createSignal, on, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { TeamRunShare } from "../../ipc/team";
import { Switch, Users } from "../../ui-kit";
import { loaded, loadTeam, view } from "./store";
import "./team.css";

const inTeam = () => view().state === "member";

/** The New run panel's toggle. Nothing is shown (and nothing is asked) while this install is not in a team. */
export function NewRunShare(props: { checked: boolean; onChange: (shared: boolean) => void }) {
  onMount(() => !loaded() && void loadTeam());
  return (
    <Show when={inTeam()}>
      <div class="team-runshare" data-testid="newrun-share">
        <Users size={14} />
        <Switch size="sm" checked={props.checked} onChange={props.onChange} label={t("team.share.newRun")} />
        <span class="team-note">{props.checked ? t("team.share.newRunOn") : t("team.share.newRunOff")}</span>
      </div>
    </Show>
  );
}

/** The run header's toggle. It appears only for a run whose project is shared with the team. */
export function HeaderShare(props: { runId: string }) {
  const [state, setState] = createSignal<TeamRunShare | undefined>(undefined);
  onMount(() => !loaded() && void loadTeam());
  const refresh = () => {
    const id = props.runId;
    if (!inTeam()) return setState(undefined);
    ipc.team.runShareState(id).then((s) => id === props.runId && setState(s), () => setState(undefined));
  };
  createEffect(on([() => props.runId, () => view().state], refresh));
  const toggle = (shared: boolean) => {
    setState((s) => (s ? { ...s, shared } : s));
    ipc.team.runShare(props.runId, shared).catch(refresh);
  };
  return (
    <Show when={state()?.available}>
      <span class="team-runshare team-runshare--header" data-testid="header-share" title={t("team.share.runTip")}>
        <Users size={12} />
        <Switch size="sm" checked={state()?.shared ?? false} onChange={toggle} aria-label={t("team.share.run")} label={t("team.share.run")} />
      </span>
    </Show>
  );
}
