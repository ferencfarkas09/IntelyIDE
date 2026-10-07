import { createSignal, Show } from "solid-js";
import { t, type MessageKey } from "../../../i18n";
import { Button, Checkbox, Input } from "../../../ui-kit";
import { createApplier } from "./apply";
import { cloudApi } from "./api";
import { ErrorSummary, ReasonButton, StatusBadge, TrustNote } from "./common";
import { customUrlProblem, errorCodeOf, hostOf, PUBKEY_RE, VERDICT_KEY, verdictAllowsApply, verdictTone } from "./logic";
import { refreshCloud } from "./store";
import type { CloudView, RelayCheck } from "./types";

const PROBLEM_KEY: Record<NonNullable<ReturnType<typeof customUrlProblem>>, MessageKey> = {
  empty: "remote.cloud.custom.p.empty",
  syntax: "remote.cloud.custom.p.syntax",
  scheme: "remote.cloud.custom.p.scheme",
  ip: "remote.cloud.custom.p.ip",
  extra: "remote.cloud.custom.p.extra",
};

/** Bring your own relay: Check, acknowledge the host, Use ((design notes: remote-cloudflare-spec) 3.4). No wrangler involved. */
export function CustomPanel(props: { view: CloudView; readOnly: boolean }) {
  const [url, setUrl] = createSignal(props.view.custom?.url ?? "");
  const [pub, setPub] = createSignal(props.view.custom?.pubkey ?? "");
  const [check, setCheck] = createSignal<RelayCheck | null>(null);
  const [ack, setAck] = createSignal(false);
  const [typedHost, setTypedHost] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [code, setCode] = createSignal<string | null>(null);

  const urlProblem = () => (url().trim() ? customUrlProblem(url()) : null);
  const pubProblem = () => pub().trim() !== "" && !PUBKEY_RE.test(pub().trim());
  const host = () => hostOf(url().trim());
  const doCheck = async () => {
    setBusy(true);
    setCode(null);
    setCheck(null);
    try {
      setCheck(await cloudApi().verify({ target: "custom", url: url().trim(), pubkey: pub().trim() || undefined }));
    } catch (e) {
      setCode(errorCodeOf(e));
    } finally {
      setBusy(false);
    }
  };
  const applier = createApplier("custom", () => url().trim(), () => void refreshCloud(), async (confirmUnpair) => {
    await cloudApi().customSet({ url: url().trim(), pubkey: pub().trim() || undefined, acknowledgeHost: typedHost() });
    await cloudApi().apply({ mode: "custom", confirmUnpair });
  });
  const reason = (): string | null => {
    if (customUrlProblem(url())) return t("remote.cloud.custom.need.url");
    if (pubProblem()) return t("remote.cloud.custom.p.pub");
    const c = check();
    if (!c) return t("remote.cloud.custom.need.check");
    if (!c.reachable || !verdictAllowsApply(c.verdict, true)) return t("remote.cloud.verify.blocked");
    if (!ack()) return t("remote.cloud.block.ack");
    if (typedHost() !== host()) return t("remote.cloud.block.typed", { text: host() });
    return null;
  };
  const yn = (b: boolean | null) => (b == null ? t("remote.cloud.unknown") : b ? t("remote.cloud.yes") : t("remote.cloud.no"));
  return (
    <div class="cloud-stack cloud-pad" data-testid="custom-panel">
      <label class="cloud-label" for="cloud-custom-url">{t("remote.cloud.custom.url")}</label>
      <Input id="cloud-custom-url" size="sm" value={url()} placeholder="wss://relay.example.com" spellcheck={false} autocomplete="off" invalid={!!urlProblem()} disabled={props.readOnly} dir="ltr" onInput={(e) => (setUrl(e.currentTarget.value), setCheck(null))} data-testid="custom-url" />
      <Show when={urlProblem()}>{(p) => <p class="cloud-note cloud-warn" role="note">{t(PROBLEM_KEY[p()])}</p>}</Show>
      <label class="cloud-label" for="cloud-custom-pub">{t("remote.cloud.custom.pub")}</label>
      <Input id="cloud-custom-pub" size="sm" value={pub()} spellcheck={false} autocomplete="off" invalid={pubProblem()} disabled={props.readOnly} dir="ltr" onInput={(e) => (setPub(e.currentTarget.value), setCheck(null))} data-testid="custom-pub" />
      <p class="cloud-note">{pubProblem() ? t("remote.cloud.custom.p.pub") : t("remote.cloud.custom.pubHint")}</p>
      <div class="cloud-actions">
        <Button variant="secondary" size="sm" disabled={props.readOnly || !url().trim() || !!urlProblem() || pubProblem()} loading={busy()} onClick={() => void doCheck()} data-testid="custom-check">
          {t("remote.cloud.custom.check")}
        </Button>
      </div>
      <Show when={check()}>
        {(c) => (
          <dl class="cloud-dl" data-testid="custom-result">
            <dt>{t("remote.cloud.status.reachable")}</dt>
            <dd><StatusBadge tone={c().reachable ? "ok" : "danger"}>{yn(c().reachable)}</StatusBadge></dd>
            <dt>{t("remote.cloud.custom.protocol")}</dt>
            <dd>{c().protocol === "intely.v1" ? t("remote.cloud.yes") : t("remote.cloud.no")}</dd>
            <dt>{t("remote.cloud.status.version")}</dt>
            <dd>{c().relayVersion ?? "-"}</dd>
            <dt>{t("remote.cloud.verify.verdict")}</dt>
            <dd>
              <StatusBadge tone={verdictTone(c().verdict)}>{t(VERDICT_KEY[c().verdict])}</StatusBadge>
              <Show when={c().verdict === "observed"}>
                <p class="cloud-note cloud-warn" data-testid="not-verified">{t("remote.cloud.custom.notVerified")}</p>
              </Show>
            </dd>
          </dl>
        )}
      </Show>
      <TrustNote />
      <Checkbox checked={ack()} onChange={setAck} disabled={props.readOnly} label={t("remote.cloud.custom.ack")} />
      <label class="cloud-label" for="cloud-custom-host">{t("remote.cloud.typeToConfirm", { text: host() || "host" })}</label>
      <Input id="cloud-custom-host" size="sm" value={typedHost()} spellcheck={false} autocomplete="off" autocapitalize="off" disabled={props.readOnly} dir="ltr" onInput={(e) => setTypedHost(e.currentTarget.value)} data-testid="custom-host" />
      <div class="cloud-actions">
        <ReasonButton variant="primary" reason={props.readOnly ? t("remote.cloud.err.readOnly") : reason()} reasonId="cloud-custom-reason" loading={applier.busy()} onClick={applier.start} data-testid="custom-use">
          {t("remote.cloud.useNow")}
        </ReasonButton>
      </div>
      <p id="cloud-custom-reason" class="cloud-note" aria-live="polite">{props.readOnly ? t("remote.cloud.err.readOnly") : (reason() ?? t("remote.cloud.block.ready"))}</p>
      <ErrorSummary code={code() ?? applier.code()} />
      {applier.dialog()}
    </div>
  );
}
