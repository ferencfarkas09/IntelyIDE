import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { errorText } from "../../store/snapshots";
import { Badge, Button, Dialog, FormGroup, FormRow, Input, Switch, toast } from "../../ui-kit";
import type { ProviderEnforcement, ProviderInfo } from "../../ipc/providers";
import { TIER_LABEL, TIER_TONE, tierFor } from "./enforcement";
import { replaceProvider } from "./logic";
import "./providers.css";

/**
 * Settings > Safety: "allow weak writer", per provider, off by default, turned on only by typing the provider's id. It lets a
 * provider below the write tier run roles that change files. The chip stays Weak; commit and push stay blocked and Rewind still
 * snapshots. Shown only while Experimental providers is on (the Safety section loads this lazily).
 */
export default function WeakWriterControls() {
  const [providers, setProviders] = createSignal<ProviderInfo[]>([]);
  const [enforcement, setEnforcement] = createSignal<ProviderEnforcement[]>([]);
  const [asking, setAsking] = createSignal<ProviderInfo | null>(null);
  const [typed, setTyped] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  onMount(() => {
    void ipc.providers.list().then(setProviders, () => {});
    void ipc.providers.enforcement().then(setEnforcement, () => {});
  });

  /** Providers the override can apply to: experimental, switched on and usable (a confirmed command line). */
  const candidates = createMemo(() => providers().filter((p) => p.experimental && p.enabled && p.state !== "off" && (p.state === "ready" || p.allowWeakWriter)));

  async function apply(p: ProviderInfo, allow: boolean, confirmation?: string) {
    setBusy(true);
    try {
      const next = await ipc.providers.setWeakWriter(p.id, allow, confirmation);
      setProviders((l) => replaceProvider(l, next));
      setAsking(null);
    } catch (e) {
      toast.error(t("providers.ww.failed"), errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const change = (p: ProviderInfo, on: boolean) => {
    if (on) {
      setTyped("");
      setAsking(p);
    } else void apply(p, false);
  };

  return (
    <FormGroup title={t("providers.ww.title")} description={t("providers.ww.desc")}>
      <Show when={candidates().length > 0} fallback={<FormRow label={t("providers.ww.title")} description={t("providers.ww.none")} />}>
        <For each={candidates()}>
          {(p) => (
            <FormRow label={t("providers.ww.row", { name: p.name })} description={t("providers.ww.rowDesc", { tier: TIER_LABEL[tierFor(enforcement(), p.id, "write").tier] })}>
              <Badge size="sm" tone={TIER_TONE[tierFor(enforcement(), p.id, "write").tier]}>{TIER_LABEL[tierFor(enforcement(), p.id, "write").tier]}</Badge>
              <Switch aria-label={t("providers.ww.switchAria", { name: p.name })} checked={p.allowWeakWriter} onChange={(on) => change(p, on)} />
            </FormRow>
          )}
        </For>
      </Show>
      <Dialog
        open={asking() !== null}
        onClose={() => setAsking(null)}
        size="sm"
        role="alertdialog"
        title={t("providers.ww.dialogTitle", { name: asking()?.name ?? "" })}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAsking(null)}>{t("providers.ww.cancel")}</Button>
            <Button variant="danger" loading={busy()} disabled={typed().trim() !== asking()?.id} onClick={() => void apply(asking()!, true, typed())}>{t("providers.ww.allow")}</Button>
          </>
        }
      >
        <p class="ww__body">{t("providers.ww.dialogBody", { name: asking()?.name ?? "" })}</p>
        <label class="ww__type">
          <span>{t("providers.ww.typePrompt", { id: asking()?.id ?? "" })}</span>
          <Input data-autofocus size="sm" aria-label={t("providers.ww.typeAria")} autocomplete="off" spellcheck={false} value={typed()} onInput={(e) => setTyped(e.currentTarget.value)} />
        </label>
      </Dialog>
    </FormGroup>
  );
}
