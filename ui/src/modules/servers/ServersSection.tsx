import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import type { ServerCfg } from "../../ipc/servers";
import { Button, Dialog, Plus, toast } from "../../ui-kit";
import { ServerCard } from "./ServerCard";
import { ServerForm } from "./ServerForm";
import { loaded, loadError, loadServers, messageOf, removeServer, servers } from "./store";
import "./servers.css";

/** Settings > Servers: the machines agents can run on over SSH, with their checks, setup and repositories. */
export default function ServersSection() {
  const [form, setForm] = createSignal<{ cfg?: ServerCfg } | undefined>(undefined);
  const [removing, setRemoving] = createSignal<ServerCfg | undefined>(undefined);
  const [removeError, setRemoveError] = createSignal<string | undefined>(undefined);
  const [removeBusy, setRemoveBusy] = createSignal(false);

  const ids = createMemo(() => servers().map((s) => s.cfg.id));

  onMount(() => void loadServers());

  const confirmRemove = async () => {
    const cfg = removing();
    if (!cfg) return;
    setRemoveBusy(true);
    try {
      await removeServer(cfg.id);
      setRemoving(undefined);
      toast.success(t("servers.removed", { name: cfg.name }));
    } catch (e) {
      setRemoveError(messageOf(e));
    } finally {
      setRemoveBusy(false);
    }
  };

  return (
    <section class="ui-formgroup srv-section">
      <header class="ui-formgroup__head">
        <h4 class="ui-formgroup__title">{t("servers.title")}</h4>
        <p class="ui-formgroup__desc">{t("servers.desc")}</p>
      </header>
      <div class="srv-body">
        <p class="srv-form__note">{t("servers.security")}</p>
        <Show when={loadError()}>{(m) => <p class="srv-card__error" role="alert">{m()}</p>}</Show>
        <Show when={servers().length > 0} fallback={<Show when={loaded()}><p class="srv-empty">{t("servers.empty")}</p></Show>}>
          <ul class="srv-list" aria-label={t("servers.title")}>
            {/* Keyed by id: a fresh status must update the card, not rebuild it (an open panel would close). */}
            <For each={ids()}>
              {(id) => (
                <Show when={servers().find((s) => s.cfg.id === id)}>
                  {(v) => <ServerCard view={v()} onEdit={() => setForm({ cfg: v().cfg })} onDelete={() => (setRemoveError(undefined), setRemoving(v().cfg))} />}
                </Show>
              )}
            </For>
          </ul>
        </Show>
        <div class="srv-actions">
          <Button size="sm" variant="secondary" icon={Plus} onClick={() => setForm({})}>
            {t("servers.add")}
          </Button>
        </div>
      </div>
      <Show when={form()}>{(f) => <ServerForm cfg={f().cfg} onClose={() => setForm(undefined)} />}</Show>
      <Dialog
        open={!!removing()}
        onClose={() => setRemoving(undefined)}
        role="alertdialog"
        size="sm"
        title={t("servers.deleteTitle", { name: removing()?.name ?? "" })}
        description={t("servers.deleteBody")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(undefined)}>{t("servers.form.cancel")}</Button>
            <Button variant="danger" loading={removeBusy()} onClick={() => void confirmRemove()}>{t("servers.delete")}</Button>
          </>
        }
      >
        <Show when={removeError()}>{(m) => <p class="srv-form__error" role="alert">{m()}</p>}</Show>
      </Dialog>
    </section>
  );
}
