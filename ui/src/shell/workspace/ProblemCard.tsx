import { Show } from "solid-js";
import { fmt, t } from "../../i18n";
import { exitApp } from "../../platform/closeGuard";
import { Button, CircleAlert, Icon, Menu, toast, TriangleAlert } from "../../ui-kit";
import { crashLoop, forceOpen, registryProblem, reloadPage, restoreRegistryBackup, startFreshRegistry } from "../../store/workspaces";
import { workspaceErrorText } from "./errors";

/** Why the registry could not be used (3.11): damaged, newer, legacy unreadable, test jail, another instance. */
export function ProblemCard() {
  const problem = registryProblem;

  async function restore(name: string) {
    try {
      await restoreRegistryBackup(name);
    } catch (e) {
      toast.error(workspaceErrorText(e));
    }
  }
  async function fresh() {
    try {
      await startFreshRegistry();
    } catch (e) {
      toast.error(workspaceErrorText(e));
    }
  }

  return (
    <Show when={problem()}>
      {(p) => (
        <section class="problem" role="alert" data-kind={p().kind} aria-labelledby="problem-title">
          <h3 id="problem-title" class="problem__title">
            <Icon icon={CircleAlert} size={16} />
            <Show when={p().kind === "corrupt"}>{t("welcome.problem.corrupt")}</Show>
            <Show when={p().kind === "ioError"}>{t("welcome.problem.io", { reason: p().message })}</Show>
            <Show when={p().kind === "newerVersion"}>{t("welcome.problem.newer")}</Show>
            <Show when={p().kind === "legacyUnreadable"}>{t("welcome.problem.legacy")}</Show>
            <Show when={p().kind === "testJail"}>{t("ws.error.testJail")}</Show>
            <Show when={p().kind === "otherInstance"}>{t("welcome.otherInstance")}</Show>
          </h3>
          <Show when={p().message && (p().kind === "corrupt" || p().kind === "legacyUnreadable" || p().kind === "newerVersion")}>
            <p class="problem__detail">{t("welcome.problem.detail")} <span dir="ltr">{p().message}</span></p>
          </Show>
          <div class="problem__actions">
            <Show when={(p().kind === "corrupt" || p().kind === "ioError") && p().backups.length > 0}>
              <Menu
                aria-label={t("welcome.problem.restore")}
                placement="bottom-start"
                items={p().backups.map((b) => ({ label: t("welcome.problem.restoreItem", { when: fmt.date(b.at, "medium"), count: b.workspaces }), onSelect: () => void restore(b.name) }))}
                trigger={(tp) => <Button {...tp} variant="secondary" size="sm">{t("welcome.problem.restore")}</Button>}
              />
            </Show>
            <Show when={p().kind === "corrupt" || p().kind === "ioError"}>
              <Button variant="secondary" size="sm" onClick={() => void fresh()}>{t("welcome.problem.fresh")}</Button>
            </Show>
            <Show when={p().kind === "corrupt" || p().kind === "ioError" || p().kind === "newerVersion"}>
              <Button variant="ghost" size="sm" onClick={reloadPage}>{t("welcome.problem.retry")}</Button>
            </Show>
            <Show when={p().kind === "newerVersion" || p().kind === "otherInstance"}>
              <Button variant="ghost" size="sm" onClick={exitApp}>{t("welcome.problem.quit")}</Button>
            </Show>
          </div>
        </section>
      )}
    </Show>
  );
}

/** "IntelyIDE did not start cleanly the last two times": the crash-loop guard kept the workspace closed. */
export function CrashLoopNotice() {
  return (
    <Show when={crashLoop()}>
      {(c) => (
        <section class="problem" role="status" data-kind="crashLoop" aria-labelledby="crash-title">
          <h3 id="crash-title" class="problem__title">
            <Icon icon={TriangleAlert} size={16} />
            {t("welcome.crashLoop", { name: c().name })}
          </h3>
          <div class="problem__actions">
            <Button variant="secondary" size="sm" onClick={() => void forceOpen(c().id)}>{t("welcome.openAnyway")}</Button>
          </div>
        </section>
      )}
    </Show>
  );
}
