import { For, Show, type JSX } from "solid-js";
import { Badge } from "@ui/ui-kit/Badge";
import { Icon } from "@ui/ui-kit/Icon";
import { Spinner } from "@ui/ui-kit/Spinner";
import { CircleAlert, CircleCheck, Clock, Inbox } from "@ui/ui-kit/icons";
import { Bell } from "lucide-solid";
import { cardsOf, groups, homeCards, needsYouCards, refresh, state } from "../core/app";
import type { RunCard } from "../core/wire";
import { Cards } from "./Cards";
import { ConnChip } from "../ui/ConnChip";
import { go } from "../ui/nav";
import { PullToRefresh } from "../ui/PullToRefresh";
import { clock, elapsed } from "../ui/format";


function StatusIcon(props: { run: RunCard; group: string }) {
  return (
    <span class="status" data-status={props.group} aria-hidden="true">
      <Show when={props.group === "needsYou"}>
        <Icon icon={Bell} size={20} />
      </Show>
      <Show when={props.group === "running"}>
        <Spinner size={16} />
      </Show>
      <Show when={props.group === "ready"}>
        <Icon icon={CircleCheck} size={20} />
      </Show>
      <Show when={props.group === "failed"}>
        <Icon icon={CircleAlert} size={20} />
      </Show>
      <Show when={props.group === "earlier"}>
        <Icon icon={Clock} size={20} />
      </Show>
    </span>
  );
}

const WORD: Record<string, string> = { needsYou: "Needs you", running: "Running", ready: "Ready to review", failed: "Failed", earlier: "Earlier" };

function Row(props: { run: RunCard; group: string }) {
  const open = () => cardsOf(props.run.agentId).filter((c) => !c.resolution);
  const line = () => open()[0]?.question ?? open()[0]?.summary ?? (props.run.lastText || WORD[props.group]);
  return (
    <button type="button" class="run-row" data-testid="run-row" data-group={props.group} onClick={() => go(`#/run/${encodeURIComponent(props.run.agentId)}`)}>
      <StatusIcon run={props.run} group={props.group} />
      <span class="run-row__main">
        <span class="run-row__title">{props.run.title || "Untitled run"}</span>
        <span class="run-row__line">{line()}</span>
        <span class="run-row__meta">
          <Badge size="sm">{props.run.role}</Badge>
          <span class="muted small">
            {WORD[props.group]} · {elapsed(props.run.startedAt)}
          </span>
        </span>
      </span>
    </button>
  );
}

function Group(props: { id: string; runs: RunCard[]; children?: JSX.Element }) {
  return (
    <Show when={props.runs.length}>
      <section class="group" data-group={props.id} aria-label={WORD[props.id]}>
        <h2 class="group__title">
          {WORD[props.id]} <span class="count">{props.runs.length}</span>
        </h2>
        {props.children}
        <For each={props.runs}>{(r) => <Row run={r} group={props.id} />}</For>
      </section>
    </Show>
  );
}

export default function Home() {
  const g = () => groups();
  const empty = () => state.runs.length === 0;
  return (
    <main class="screen">
      <header class="topbar">
        <div>
          <h1 class="topbar__title">Sessions</h1>
          <p class="topbar__sub">{state.macName}</p>
        </div>
        <ConnChip />
      </header>
      <Show when={state.conn === "macOffline" || (state.staleSince && state.conn !== "live")}>
        <p class="banner" role="status" data-testid="offline-banner">
          {state.conn === "macOffline" ? "Mac offline" : "Not connected"}: showing data from {clock(state.staleSince ?? state.macLastSeen ?? Date.now())}. Answers are disabled until the Mac is back.
        </p>
      </Show>
      <Show when={state.banner}>
        <p class="banner" role="status">
          {state.banner}
        </p>
      </Show>
      <PullToRefresh onRefresh={refresh}>
        <Show when={homeCards().length}>
          <section class="group" data-group="needsYou-cards" aria-label="Needs you">
            <h2 class="group__title">
              Needs you <span class="count" data-testid="needs-count">{needsYouCards().length}</span>
            </h2>
            <For each={homeCards()}>
              {(c) => (
                <div class="card-wrap">
                  <Cards card={c} showRun />
                  <button type="button" class="link" onClick={() => go(`#/run/${encodeURIComponent(c.agentId)}`)}>
                    Open run
                  </button>
                </div>
              )}
            </For>
          </section>
        </Show>
        <Group id="needsYou" runs={g().needsYou.filter((r) => !needsYouCards().some((c) => c.agentId === r.agentId))} />
        <Group id="running" runs={g().running} />
        <Group id="ready" runs={g().ready} />
        <Group id="failed" runs={g().failed} />
        <Group id="earlier" runs={g().earlier.slice(0, 4)} />
        <Show when={empty() && state.conn === "live"}>
          <div class="empty" data-testid="empty">
            <Icon icon={Inbox} size={24} />
            <p>All quiet. Nothing needs you.</p>
          </div>
        </Show>
        <Show when={empty() && state.conn !== "live"}>
          <div class="empty">
            <Icon icon={Clock} size={24} />
            <p>Waiting for your Mac…</p>
          </div>
        </Show>
      </PullToRefresh>
    </main>
  );
}
