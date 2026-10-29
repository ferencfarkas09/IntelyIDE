import { createResource, For, Show } from "solid-js";
import { t } from "../../../i18n";
import { ipc } from "../../../ipc";
import { CircleCheck, EmptyState, IconButton, ScrollArea, toast, X } from "../../../ui-kit";
import { inbox } from "../../runs/inbox";
import { InboxEntryView } from "../../runs/NeedsYouInbox";
import { radarApi } from "./api";
import "../../runs/runs.css";
import "../../../components/chat/chat.css";
import "./radar.css";

/** The Needs-You radar: the runs waiting on the person (permission, question, plan) with the same cards and IPC as the in-app inbox. */
export function Radar() {
  // Repository names for the cards; the radar has no workspace UI, so it asks once.
  const [names] = createResource(async () => {
    try {
      return new Map((await ipc.workspaceGet()).repos.map((r) => [r.id, r.name] as const));
    } catch {
      return new Map<string, string>();
    }
  });
  const openRun = (agentId: string) => void radarApi().openRun(agentId).catch((e) => toast.error(t("dash.radar.openFailed"), String((e as { message?: string }).message ?? e)));
  return (
    <div class="radar" data-testid="radar">
      <header class="radar__bar" data-tauri-drag-region>
        <h1 class="radar__title" data-tauri-drag-region>
          {t("dash.radar.title", { n: inbox().length })}
        </h1>
        <IconButton size="sm" icon={X} label={t("dash.radar.close")} onClick={() => void radarApi().close().catch(() => {})} />
      </header>
      <Show when={inbox().length > 0} fallback={<EmptyState size="sm" icon={CircleCheck} title={t("dash.radar.none")} description={t("dash.radar.noneWhy")} />}>
        <ScrollArea class="radar__scroll">
          <ul class="inbox__list radar__list">
            <For each={inbox()}>{(entry) => <InboxEntryView entry={entry} onOpen={openRun} repoName={(id) => names()?.get(id)} />}</For>
          </ul>
        </ScrollArea>
      </Show>
      <div class="ui-sr-only" role="status" aria-live="polite">
        {t("dash.radar.count", { n: inbox().length })}
      </div>
    </div>
  );
}
