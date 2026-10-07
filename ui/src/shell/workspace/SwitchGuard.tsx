import { createMemo, For, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { BusyItem, BusyKind } from "../../ipc/workspaces";
import { runningOps } from "../../store/workspace";
import { activeSummary, guard, guardCancel, guardForceSwitch, guardRecheck, guardSaveAndSwitch } from "../../store/workspaces";
import { hasBlocking } from "../../store/workspaceBusy";
import { Button, CircleAlert, Dialog, Icon, Spinner, TriangleAlert } from "../../ui-kit";
import { listTitles } from "../CloseGuard";
import { BLOCKER_KEYS } from "./errors";

/** One line per busy item: what is running and what the switch will do about it (guard.* strings). */
export function blockerLine(item: BusyItem, unsaved?: readonly string[]): string {
  const count = item.count;
  const labels = item.labels.join(", ");
  switch (item.kind as BusyKind) {
    case "gitRun":
      return t("guard.git", { count });
    case "agent":
      return t("guard.agents", { count });
    case "devServer":
      return t("guard.servers", { count });
    case "check":
      return t("guard.checks", { count });
    case "terminal":
      return t("guard.terminals", { count });
    case "preview":
      return t("guard.previews", { count });
    case "gitOp":
      return t("guard.blocker.gitOp", { labels });
    case "unsaved":
      return t("guard.unsaved", { count, names: listTitles(unsaved ?? item.labels) });
    default:
      return t(BLOCKER_KEYS[item.kind], { count, labels });
  }
}

async function cancelOperations(): Promise<void> {
  for (const op of runningOps()) {
    if (op.kind === "commit") await ipc.commitCancel(op.runId).catch(() => undefined);
    if (op.kind === "push") await ipc.pushCancel(op.runId).catch(() => undefined);
  }
  await guardRecheck();
}

/**
 * What stands between the user and a switch (3.9): one dialog for every blocker. A running commit, push or Git operation
 * blocks (the buttons stay disabled and the dialog re-reads the state every second); everything else is confirmable.
 */
export function SwitchGuard() {
  const g = guard;
  const blocked = () => (g() ? hasBlocking(g()!.model) : false);
  const unsaved = () => g()?.model.unsaved ?? [];
  const busy = () => g()?.stage !== "idle";
  const currentName = () => activeSummary()?.name ?? "";
  const lines = createMemo(() => {
    const model = g()?.model;
    if (!model) return [] as { key: string; kind: "block" | "ask"; text: string }[];
    const items: { key: string; kind: "block" | "ask"; text: string }[] = [];
    for (const i of model.blocking) items.push({ key: `b-${i.kind}`, kind: "block", text: blockerLine(i) });
    if (model.unsaved.length) items.push({ key: "unsaved", kind: "ask", text: blockerLine({ kind: "unsaved", count: model.unsaved.length, labels: model.unsaved }, model.unsaved) });
    for (const i of model.confirmable) items.push({ key: `c-${i.kind}`, kind: "ask", text: blockerLine(i) });
    return items;
  });
  const hasRunningOp = () => (g()?.model.blocking ?? []).some((i) => i.kind === "gitRun");
  const label = (a: "switch" | "close") => (a === "switch" ? t("guard.stopSwitch") : t("guard.stopClose"));

  return (
    <Dialog
      open={g() !== null}
      onClose={guardCancel}
      title={g()?.closing ? t("guard.titleClose") : t("guard.title")}
      description={t("guard.intro", { name: currentName() })}
      size="md"
      role="alertdialog"
      class="guard"
      initialFocus={() => document.querySelector<HTMLElement>("[data-guard-cancel]")}
      footer={
        <>
          <Show when={hasRunningOp()}>
            <Button variant="secondary" onClick={() => void cancelOperations()}>{t("guard.cancelOp")}</Button>
          </Show>
          <Button variant="ghost" data-guard-cancel onClick={guardCancel}>{t("guard.cancel")}</Button>
          <Show when={unsaved().length > 0}>
            <Button variant="danger" disabled={blocked() || busy()} onClick={() => void guardForceSwitch()}>{t("guard.discardSwitch")}</Button>
            <Button variant="primary" disabled={blocked() || busy()} loading={g()?.stage === "saving"} onClick={() => void guardSaveAndSwitch()}>{t("guard.saveSwitch")}</Button>
          </Show>
          <Show when={unsaved().length === 0}>
            <Button variant="primary" disabled={blocked() || busy()} loading={g()?.stage === "stopping"} onClick={() => void guardForceSwitch()}>{label(g()?.closing ? "close" : "switch")}</Button>
          </Show>
        </>
      }
    >
      <ul class="guard__list" role="list">
        <For each={lines()}>
          {(line) => (
            <li class="guard__item" data-kind={line.kind}>
              <Icon icon={line.kind === "block" ? CircleAlert : TriangleAlert} size={16} />
              <span>{line.text}</span>
            </li>
          )}
        </For>
      </ul>
      <Show when={blocked()}>
        <p class="guard__waiting" role="status">
          <Spinner size={14} />
          {t("guard.waiting")}
        </p>
      </Show>
      <Show when={g()?.saveFailed}>
        <p class="guard__error" role="alert">{t("guard.saveFailed")}</p>
      </Show>
    </Dialog>
  );
}

export default SwitchGuard;
