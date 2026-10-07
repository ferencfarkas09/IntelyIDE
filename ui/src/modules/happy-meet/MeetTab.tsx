import { createResource, For, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { Meeting } from "../../ipc/happy";
import { openSettings } from "../../platform/settings";
import { meetClock, meetView, providerState, refreshHappyStatus } from "../../store/happy";
import { Badge, Button, EmptyState, IconButton, RefreshCw, Skeleton, StatusDot, TriangleAlert, Video } from "../../ui-kit";
import { joinMeeting } from "./actions";
import { hhmm, sortMeetings, whenLabel } from "./logic";
import "./meet.css";

/** The dock tab: live meetings, then the upcoming ones, each with a Join button that opens the browser. */
export default function MeetTab() {
  const live = () => providerState("meet") === "ready" || providerState("meet") === "degraded";
  return (
    <Show
      when={live()}
      fallback={
        <EmptyState
          icon={Video}
          title={t("hm.off.title")}
          description={t("hm.off.body")}
          action={<Button onClick={() => { void refreshHappyStatus(); openSettings("integrations"); }}>{t("hx.openSettings")}</Button>}
        />
      }
    >
      <Meetings />
    </Show>
  );
}

function Meetings() {
  const [fetched, { refetch }] = createResource(() => ipc.happy.meet.list());
  const groups = () => sortMeetings(meetView().meetings);
  const stale = () => meetView().stale;
  return (
    <div class="mt">
      <header class="mt__head">
        <h4 class="mt__title">{t("hm.title")}</h4>
        <Show when={stale()}><Badge size="sm" tone="warn" title={t("hm.staleTip")}>{t("hm.outOfDate")}</Badge></Show>
        <IconButton icon={RefreshCw} label={t("hx.refresh")} size="sm" loading={fetched.loading} onClick={() => void refetch()} />
      </header>
      <div class="mt__body">
        <Show when={!fetched.loading || meetView().meetings.length} fallback={<><Skeleton height={44} /><Skeleton height={44} /></>}>
          <Show when={!fetched.error || meetView().meetings.length} fallback={<EmptyState size="sm" tone="danger" icon={TriangleAlert} title={t("hm.loadFailed")} description={(fetched.error as { message?: string })?.message} action={<Button size="sm" onClick={() => void refetch()}>{t("hx.retry")}</Button>} />}>
            <Section title={t("hm.live")} items={groups().live} empty={t("hm.emptyLive")} />
            <Section title={t("hm.upcoming")} items={groups().upcoming} empty={t("hm.emptyUpcoming")} />
          </Show>
        </Show>
      </div>
    </div>
  );
}

/** `#ops · Anna · 5 in the room`, `Direct · 14:30 (in 9 min)`. */
function metaLine(m: Meeting): string {
  const when = m.status === "live" ? t("hm.inRoom", { n: m.participants }) : m.startMs != null ? t("hm.time", { time: hhmm(m.startMs), when: whenLabel(m.startMs, meetClock()) }) : "";
  return [m.channel ? `#${m.channel}` : t("hm.direct"), m.host, when].filter(Boolean).join(" · ");
}

function Section(props: { title: string; items: Meeting[]; empty: string }) {
  return (
    <section class="mt__section">
      <h5 class="mt__section-title">{props.title}</h5>
      <For each={props.items} fallback={<p class="mt__empty">{props.empty}</p>}>
        {(m) => (
          <div class="mt__row" data-live={m.status === "live" ? "" : undefined}>
            <div class="mt__text">
              <span class="mt__name ui-truncate">{m.title}</span>
              <span class="mt__meta ui-truncate">
                {metaLine(m)}
              </span>
            </div>
            <Show when={m.status === "live"}><StatusDot tone="accent" size={6} pulse label={t("hm.liveLabel")} /></Show>
            <Button size="sm" variant={m.status === "live" ? "primary" : "secondary"} onClick={() => void joinMeeting(m.id, m.title)}>{t("hm.join")}</Button>
          </div>
        )}
      </For>
    </section>
  );
}
