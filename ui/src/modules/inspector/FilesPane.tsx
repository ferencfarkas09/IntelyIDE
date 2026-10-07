import { For, Show } from "solid-js";
import { t } from "../../i18n";
import { setSelectedFile } from "../../store/selection";
import { snapshots } from "../../store/snapshots";
import { repoConfig } from "../../store/workspace";
import { Badge, EmptyState, FileDiff, FileText, IconButton, RepoBadge } from "../../ui-kit";
import type { Inspection, TouchedFile } from "./model";

const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** A touched file can open its diff only while it is still a change of the repo. */
export const stillChanged = (f: Pick<TouchedFile, "repoId" | "path">): boolean => !!f.repoId && !!snapshots()[f.repoId]?.changes.some((c) => c.path === f.path);

export function FilesPane(props: { inspection: Inspection }) {
  return (
    <Show when={props.inspection.files.length > 0} fallback={<EmptyState icon={FileText} size="sm" title={t("inspector.files.none")} description={t("inspector.files.noneDesc")} />}>
      <ul class="insp-files" aria-label={t("inspector.files.label")}>
        <For each={props.inspection.files}>
          {(f) => (
            <li class="insp-file">
              <Show when={f.repoId ? repoConfig(f.repoId) : undefined} fallback={<Badge size="sm">{f.repoId ?? t("inspector.files.outside")}</Badge>}>
                {(r) => <RepoBadge color={r().color} badge={r().badge} size={16} title={r().name} />}
              </Show>
              <span class="insp-file__name ui-truncate" title={f.path}>
                {nameOf(f.path)}
                <span class="ui-path-hint">{dirOf(f.path)}</span>
              </span>
              <Show when={f.created}>
                <Badge tone="ok" size="sm">{t("inspector.files.new")}</Badge>
              </Show>
              <Show when={f.deleted}>
                <Badge tone="danger" size="sm">{t("inspector.files.deleted")}</Badge>
              </Show>
              <span class="insp-file__edits ui-tnum" title={t("inspector.files.edits", { n: f.edits })}>
                {f.edits}×
              </span>
              <span class="insp-file__delta ui-tnum" aria-label={t("inspector.files.delta", { added: f.additions, removed: f.deletions })}>
                <span class="insp-add">+{f.additions}</span> <span class="insp-del">−{f.deletions}</span>
              </span>
              <IconButton
                icon={FileDiff}
                size="sm"
                label={t("inspector.files.openDiff", { name: nameOf(f.path) })}
                tooltip={stillChanged(f) ? t("inspector.files.openTip") : t("inspector.files.gone")}
                disabled={!stillChanged(f)}
                onClick={() => f.repoId && setSelectedFile(f.repoId, f.path)}
              />
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
