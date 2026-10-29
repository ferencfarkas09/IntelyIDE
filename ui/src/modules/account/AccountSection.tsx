import { createSignal, For, onMount, Show } from "solid-js";
import { fmt, t } from "../../i18n";
import { Badge, Button, Dialog, FormGroup, FormRow, toast, type Tone } from "../../ui-kit";
import { registryApi } from "./api";
import "./account.css";
import { forget, loadStatus, openPrivacy, openRegister, problemKey, problemOf, setNewsletter, status } from "./store";
import type { StoredData } from "./types";

const NEWSLETTER = {
  none: "account.set.newsletter.none",
  pending: "account.set.newsletter.pending",
  subscribed: "account.set.newsletter.subscribed",
  unsubscribed: "account.set.newsletter.unsubscribed",
  failed: "account.set.newsletter.failed",
} as const;
const NEWSLETTER_TONE: Record<string, Tone> = { subscribed: "ok", pending: "info", failed: "danger" };

const day = (seconds: number): string => fmt.date(seconds * 1000);

/** Settings > Account & data: whether this computer is registered, the newsletter, everything the registry stores (read from the registry itself), and deleting it. */
export default function AccountSection() {
  onMount(() => void loadStatus());
  const [stored, setStored] = createSignal<StoredData | undefined>();
  const [busy, setBusy] = createSignal<"show" | "news" | "delete" | undefined>();
  const [confirming, setConfirming] = createSignal(false);
  const registered = () => status()?.state === "registered";

  const fail = (e: unknown) => {
    const p = problemOf(e);
    const key = problemKey(p);
    toast.error(t("account.set.failed"), key ? t(key) : p.message);
  };

  const show = async () => {
    if (stored()) return setStored(undefined);
    setBusy("show");
    try {
      setStored(await registryApi().me());
    } catch (e) {
      fail(e);
    } finally {
      setBusy(undefined);
    }
  };

  const toggleNewsletter = async () => {
    const wants = !["pending", "subscribed"].includes(status()?.newsletter ?? "none");
    setBusy("news");
    try {
      await setNewsletter(wants);
      setStored(undefined);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(undefined);
    }
  };

  const remove = async () => {
    setBusy("delete");
    try {
      await forget();
      setStored(undefined);
      setConfirming(false);
      toast.success(t("account.set.deleted"));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(undefined);
    }
  };

  const rows = (d: StoredData): [string, string][] => {
    const c = d.computer;
    const place = c ? [c.city, c.region, c.country].filter(Boolean).join(", ") : "";
    return [
      [t("account.stored.name"), d.user.name],
      [t("account.stored.email"), d.user.email],
      [t("account.stored.agreed"), `${d.user.consentNotice}, ${day(d.user.consentAt)}`],
      [t("account.stored.newsletter"), t(NEWSLETTER[d.user.newsletter as keyof typeof NEWSLETTER] ?? NEWSLETTER.none)],
      [t("account.stored.computers"), String(d.computers)],
      ...(c
        ? ([
            [t("account.stored.system"), `${c.os} ${c.os_version}`],
            [t("account.stored.arch"), c.arch],
            [t("account.stored.cores"), String(c.cpu_cores)],
            [t("account.stored.memory"), `${c.ram_gb} GB`],
            [t("account.stored.language"), c.locale],
            [t("account.stored.timezone"), c.tz],
            [t("account.stored.app"), c.app_version],
            [t("account.stored.place"), place || "-"],
            [t("account.stored.first"), day(c.first_seen)],
            [t("account.stored.last"), day(c.last_seen)],
            [t("account.stored.launches"), String(c.launches)],
          ] as [string, string][])
        : []),
    ];
  };

  return (
    <>
      <FormGroup title={t("account.set.title")} description={t("account.set.desc", { url: status()?.url ?? "" })}>
        <FormRow
          label={t("account.set.status")}
          description={
            <Show when={registered()} fallback={status()?.state === "unasked" ? t("account.set.state.unasked") : t("account.set.state.declined")}>
              {t("account.set.state.registered", { name: status()?.name ?? "", email: status()?.email ?? "" })}
            </Show>
          }
        >
          <Show when={!registered()}>
            <Button variant="primary" onClick={openRegister}>
              {t("account.set.register")}
            </Button>
          </Show>
          <Button variant="ghost" onClick={() => void openPrivacy()}>
            {t("account.first.privacy")}
          </Button>
        </FormRow>
        <Show when={registered()}>
          <FormRow label={t("account.set.newsletter")} description={t("account.set.newsletter.desc")}>
            <div class="account-set__row-actions">
              <Badge tone={NEWSLETTER_TONE[status()?.newsletter ?? "none"] ?? "neutral"}>{t(NEWSLETTER[(status()?.newsletter ?? "none") as keyof typeof NEWSLETTER] ?? NEWSLETTER.none)}</Badge>
              <Button loading={busy() === "news"} onClick={() => void toggleNewsletter()}>
                {["pending", "subscribed"].includes(status()?.newsletter ?? "none") ? t("account.set.unsubscribe") : t("account.set.subscribe")}
              </Button>
            </div>
          </FormRow>
          <FormRow label={t("account.set.stored")} description={t("account.set.stored.desc")} stacked>
            <div class="account-set__stored">
              <div class="account-set__row-actions">
                <Button loading={busy() === "show"} onClick={() => void show()}>
                  {stored() ? t("account.set.hide") : t("account.set.show")}
                </Button>
              </div>
              <Show when={stored()}>
                {(d) => (
                  <table class="account-set__table">
                    <tbody>
                      <For each={rows(d())}>
                        {([k, v]) => (
                          <tr>
                            <th scope="row">{k}</th>
                            <td>{v}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                )}
              </Show>
            </div>
          </FormRow>
          <FormRow label={t("account.set.delete")} description={t("account.set.delete.desc")}>
            <Button variant="danger" onClick={() => setConfirming(true)}>
              {t("account.set.delete.button")}
            </Button>
          </FormRow>
        </Show>
      </FormGroup>
      <Dialog
        open={confirming()}
        onClose={() => !busy() && setConfirming(false)}
        role="alertdialog"
        size="sm"
        title={t("account.set.delete.confirm.title")}
        description={t("account.set.delete.confirm.body")}
        footer={
          <>
            <Button variant="ghost" disabled={busy() === "delete"} onClick={() => setConfirming(false)}>
              {t("account.set.delete.cancel")}
            </Button>
            <Button variant="danger" loading={busy() === "delete"} onClick={() => void remove()}>
              {t("account.set.delete.button")}
            </Button>
          </>
        }
      />
    </>
  );
}
