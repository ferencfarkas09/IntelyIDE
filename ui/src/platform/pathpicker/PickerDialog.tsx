import { createResource, createSignal, Match, Show, Switch } from "solid-js";
import { t, type MessageKey } from "../../i18n";
import { ipc } from "../../ipc";
import type { Capabilities, Picked } from "../../ipc/picker";
import { Button, Dialog, FolderOpen, SegmentedControl } from "../../ui-kit";
import { Browser } from "./Browser";
import { asEngineError, errorText } from "./errors";
import { Review } from "./Review";
import { pickerRequest, settle } from "./store";
import type { PickOptions } from "./types";
import "./pathpicker.css";

const TITLE: Record<PickOptions["kind"], MessageKey> = {
  folder: "picker.title.folder",
  folders: "picker.title.folders",
  file: "picker.title.file",
  files: "picker.title.files",
};

type Tab = "native" | "browse";
const ZERO: Capabilities = { native: false, fake: false, mode: "off" };

/** Folders that need no classification (scan roots, files) are accepted as they are; everything else is reviewed. */
const needsReview = (items: Picked[]) => items.some((p) => p.kind !== "folder" && p.kind !== "file");

export function PickerDialog(props: { opts: PickOptions }) {
  const [caps] = createResource(() => ipc.picker.capabilities().catch(() => ZERO));
  const [tab, setTab] = createSignal<Tab | null>(null);
  const [review, setReview] = createSignal<Picked[] | null>(null);
  const [note, setNote] = createSignal<string | null>(null);
  const [nativeError, setNativeError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const current = (): Tab => tab() ?? (caps()?.native ? "native" : "browse");

  const finish = (items: Picked[]) => {
    if (needsReview(items)) setReview(items);
    else settle(items);
  };

  async function runNative(): Promise<void> {
    setBusy(true);
    setNativeError(null);
    try {
      const out = await ipc.picker.native({
        kind: props.opts.kind,
        purpose: props.opts.purpose,
        title: props.opts.title,
        extensions: props.opts.extensions,
        startToken: props.opts.startToken,
      });
      if (out === null) return;
      finish(out);
    } catch (e) {
      const er = asEngineError(e);
      if (er.code === "nativeFailed") {
        setNote(t("picker.nativeFailed"));
        setTab("browse");
      } else setNativeError(errorText(er));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={() => settle(null)} title={props.opts.title ?? t(TITLE[props.opts.kind])} size="xl" class="pp-dialog">
      <Show when={caps.state !== "pending"} fallback={<div class="pp-loading" aria-busy="true" />}>
        <Switch>
          <Match when={review()}>
            {(items) => <Review items={items()} mode={caps()?.mode} onBack={() => setReview(null)} onCancel={() => settle(null)} onConfirm={(out) => settle(out)} />}
          </Match>
          <Match when={true}>
            <Show when={caps()?.native}>
              <div class="pp-tabs">
                <SegmentedControl<Tab>
                  aria-label={t(TITLE[props.opts.kind])}
                  size="sm"
                  value={current()}
                  onChange={setTab}
                  options={[
                    { value: "native", label: t("picker.tab.native") },
                    { value: "browse", label: t("picker.tab.browse") },
                  ]}
                />
              </div>
            </Show>
            <Show when={note()}>
              <p class="pp-info pp-info--warn" role="status">
                {note()}
              </p>
            </Show>
            <Show
              when={current() === "browse"}
              fallback={
                <div class="pp-native">
                  <FolderOpen size={28} aria-hidden="true" />
                  <p>{t("picker.native.hint")}</p>
                  <Show when={nativeError()}>
                    <p class="pp-error" role="alert">
                      {nativeError()}
                    </p>
                  </Show>
                  <div class="pp-actions">
                    <Button variant="ghost" onClick={() => settle(null)}>
                      {t("picker.cancel")}
                    </Button>
                    <Button variant="primary" data-autofocus loading={busy()} onClick={() => void runNative()}>
                      {t("picker.nativeButton")}
                    </Button>
                  </div>
                </div>
              }
            >
              <Browser
                kind={props.opts.kind}
                purpose={props.opts.purpose}
                extensions={props.opts.extensions}
                allowGoTo={props.opts.allowGoTo !== false}
                onPicked={finish}
                onCancel={() => settle(null)}
              />
            </Show>
          </Match>
        </Switch>
      </Show>
    </Dialog>
  );
}

/** The overlay host: mounts the dialog for the open request. */
export function PathPickerHost() {
  return <Show when={pickerRequest()}>{(r) => <PickerDialog opts={r().opts} />}</Show>;
}
