import { createEffect, For, on, onCleanup, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { execute } from "../../platform/commands";
import { ipc } from "../../ipc";
import { repos } from "../../store/workspace";
import { Button, Dialog, FileText, Icon, toast } from "../../ui-kit";
import { frameOf, postMode, previewFrames } from "./frames";
import { handleHint, openCandidate, type OpenDeps, type Outcome } from "./open";
import { parseInspectMessage } from "./protocol";
import { inspecting, picker, setPicker } from "./state";
import "./preview-inspect.css";

const MIN_GAP_MS = 150;

function depsFor(repoId: string | undefined): OpenDeps {
  return { repos: () => repos().map((r) => ({ id: r.id, path: r.path })), repoId, search: ipc.search, execute };
}

const label = (o: Extract<Outcome, { kind: "opened" }>) => t("pvi.opened.detail", { path: o.path, line: o.line, lib: o.thirdParty ? "yes" : "no", how: o.confidence });

export function report(o: Outcome): void {
  if (o.kind === "opened") toast.info(t("pvi.opened", { file: o.path.split("/").pop() ?? o.path }), [label(o), o.note].filter(Boolean).join(" · "));
  else if (o.kind === "pick") setPicker({ name: o.name, candidates: o.candidates, note: o.note });
  else toast.warn(t("pvi.toast.mapFailed"), o.reason);
}

/** Mounted once under the shell. Listens for the inspector's one message, only from preview frames, and shows the picker. */
export default function PickerAndWatcher() {
  let last = 0;

  const onMessage = (e: MessageEvent) => {
    const frame = frameOf(e);
    if (!frame) return;
    const hint = parseInspectMessage(e.data);
    if (!hint) return;
    const now = Date.now();
    if (now - last < MIN_GAP_MS) return;
    last = now;
    void handleHint(hint, depsFor(frame.dataset.repoId)).then(report, () => toast.warn(t("pvi.toast.mapFailed"), t("pvi.lookupFailed")));
  };
  // `load` does not bubble but is seen in the capture phase: a navigated frame starts with inspect mode off.
  const onLoad = (e: Event) => {
    if (inspecting() && e.target instanceof HTMLIFrameElement && e.target.hasAttribute("data-intely-preview")) postMode(e.target, true);
  };

  onMount(() => {
    window.addEventListener("message", onMessage);
    document.addEventListener("load", onLoad, true);
  });
  onCleanup(() => {
    window.removeEventListener("message", onMessage);
    document.removeEventListener("load", onLoad, true);
  });
  createEffect(
    on(inspecting, (on) => {
      document.documentElement.toggleAttribute("data-intely-inspecting", on);
      previewFrames().forEach((f) => postMode(f, on));
    }),
  );

  const choose = (index: number) => {
    const p = picker();
    const c = p?.candidates[index];
    if (!p || !c) return;
    setPicker(undefined);
    const repoId = previewFrames()[0]?.dataset.repoId;
    void openCandidate(c, depsFor(repoId)).then((ok) => ok || toast.warn(t("pvi.toast.openFailed"), c.path));
  };

  return (
    <Dialog open={!!picker()} onClose={() => setPicker(undefined)} title={t("pvi.picker.title", { name: picker()?.name ?? "" })} description={picker()?.note ?? t("pvi.picker.desc")} size="md">
      <Show when={picker()}>
        {(p) => (
          <ul class="pi__list" role="listbox" aria-label={t("pvi.candidates")}>
            <For each={p().candidates}>
              {(c, i) => (
                <li>
                  <button type="button" class="pi__row" role="option" aria-selected="false" data-autofocus={i() === 0 ? "" : undefined} onClick={() => choose(i())}>
                    <Icon icon={FileText} size={14} />
                    <span class="pi__path">{c.path}</span>
                    <span class="pi__line">:{c.line}</span>
                    <span class="pi__preview">{c.preview}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        )}
      </Show>
      <div class="pi__foot">
        <Button variant="ghost" onClick={() => setPicker(undefined)}>{t("pvi.cancel")}</Button>
      </div>
    </Dialog>
  );
}
