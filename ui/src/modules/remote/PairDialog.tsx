import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { Capability, OfferView } from "../../ipc/remote";
import { Badge, Button, Copy, Dialog, Input, SegmentedControl, ShieldCheck, Spinner, toast, TriangleAlert } from "../../ui-kit";
import { pairingLink } from "./logic";
import { encodeQr, qrPath } from "./qr";
import { onRemoteEvent, refreshRemote, remoteView } from "./state";

const message = (e: unknown): string => (typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e));

/** Pair a phone: the QR and the grouped code, then the six digits to compare, then "Codes match" with a name and a level. */
export function PairDialog(props: { open: boolean; onClose: () => void }) {
  const [offer, setOffer] = createSignal<OfferView | null>(null);
  const [sas, setSas] = createSignal<{ code: string; hint: string } | null>(null);
  const [name, setName] = createSignal("");
  const [cap, setCap] = createSignal<Capability>("view");
  const [problem, setProblem] = createSignal<string | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const [busy, setBusy] = createSignal(false);

  const link = createMemo(() => {
    const o = offer();
    const v = remoteView();
    return o && v ? pairingLink(v.relay, o.qrFragment) : "";
  });
  const qr = createMemo(() => {
    try {
      return link() ? qrPath(encodeQr(link())) : null;
    } catch {
      return null;
    }
  });
  const left = () => Math.max(0, Math.min(60, Math.ceil(((offer()?.expiresAt ?? 0) - now()) / 1000)));
  const expired = () => !!offer() && !sas() && left() === 0;

  const start = async () => {
    setProblem(null);
    setSas(null);
    setBusy(true);
    try {
      setOffer(await ipc.remote.pairStart());
    } catch (e) {
      setProblem(message(e));
    } finally {
      setBusy(false);
    }
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  onMount(() => {
    timer = setInterval(() => setNow(Date.now()), 1000);
    const off = onRemoteEvent((e) => {
      if (e.kind === "pairingSas") {
        setSas({ code: e.code, hint: e.deviceHint });
        setName((n) => n || e.deviceHint);
      } else if (e.kind === "pairingEnded") {
        if (e.outcome === "accepted") toast.show({ title: t("remote.pair.paired"), tone: "ok", duration: 3000 });
        else if (e.outcome !== "declined" && e.outcome !== "cancelled") setProblem(t("remote.pair.ended", { outcome: e.outcome }));
        if (e.outcome === "accepted" || e.outcome === "declined" || e.outcome === "cancelled") close();
      }
    });
    onCleanup(off);
  });
  createEffect(on(() => props.open, (open) => open && void start(), { defer: true }));
  onCleanup(() => timer && clearInterval(timer));

  const close = () => {
    if (offer() && !sas()) void ipc.remote.pairCancel().catch(() => {});
    setOffer(null);
    setSas(null);
    setName("");
    setCap("view");
    props.onClose();
    void refreshRemote();
  };
  const decide = async (accept: boolean) => {
    setBusy(true);
    try {
      await ipc.remote.pairConfirm(accept, { name: name().trim() || undefined, capability: cap() });
    } catch (e) {
      setProblem(message(e));
    } finally {
      setBusy(false);
    }
  };

  const bundle = () => remoteView()?.expectedBundleHash;

  return (
    <Dialog
      open={props.open}
      onClose={close}
      title={t("remote.pair")}
      size="md"
      closeOnBackdrop={false}
      footer={
        <Show
          when={sas()}
          fallback={
            <Button variant="secondary" onClick={close}>
              {t("remote.pair.cancel")}
            </Button>
          }
        >
          <Button variant="secondary" disabled={busy()} onClick={() => void decide(false)}>
            {t("remote.pair.mismatch")}
          </Button>
          <Button variant="primary" icon={ShieldCheck} loading={busy()} onClick={() => void decide(true)}>
            {t("remote.pair.approve")}
          </Button>
        </Show>
      }
    >
      <div class="remote-pair">
        <Show when={!sas()}>
          <Show when={offer()} fallback={<p class="remote-note">{busy() ? t("remote.pair.preparing") : t("remote.pair.noCode")}</p>}>
            <div class="remote-pair__qr" data-link={link()}>
              <Show when={qr()} fallback={<p class="remote-note">{t("remote.pair.tooLong")}</p>}>
                {(q) => (
                  <svg viewBox={`0 0 ${q().size} ${q().size}`} role="img" aria-label={t("remote.pair.qr")} class="remote-qr" shape-rendering="crispEdges">
                    <rect width={q().size} height={q().size} fill="#fff" />
                    <path d={q().d} fill="#000" />
                  </svg>
                )}
              </Show>
              <div class="remote-pair__side">
                <p class="remote-note">{t("remote.pair.scanHint")}</p>
                <Button size="sm" icon={Copy} onClick={() => void navigator.clipboard?.writeText(link()).then(() => toast.info(t("remote.pair.linkCopied")))}>
                  {t("remote.pair.copyLink")}
                </Button>
                <p class="remote-label">{t("remote.pair.codeLabel")}</p>
                <p class="remote-code" data-testid="manual-code">{offer()!.manualCode}</p>
                <Show
                  when={!expired()}
                  fallback={
                    <Button size="sm" variant="primary" onClick={() => void start()}>
                      {t("remote.pair.newCode")}
                    </Button>
                  }
                >
                  <p class="remote-note" data-testid="countdown">
                    {t("remote.pair.valid", { s: left() })}
                  </p>
                </Show>
              </div>
            </div>
            <div class="remote-bundle">
              <p class="remote-label">{t("remote.pair.hashLabel")}</p>
              <Show when={bundle()} fallback={<Badge tone="warn" icon={TriangleAlert}>{t("remote.pair.noHash")}</Badge>}>
                <p class="remote-hash" data-testid="expected-hash">{bundle()}</p>
              </Show>
              <p class="remote-note">{t("remote.pair.hashWarn")}</p>
            </div>
          </Show>
        </Show>

        <Show when={sas()}>
          {(s) => (
            <div class="remote-compare">
              <p class="remote-note">{t("remote.pair.answered", { name: s().hint })}</p>
              <p class="remote-sas" data-testid="sas">
                {s().code.slice(0, 3)} {s().code.slice(3)}
              </p>
              <Input size="sm" aria-label={t("remote.pair.deviceName")} value={name()} placeholder={t("remote.pair.namePh")} maxLength={40} onInput={(e) => setName(e.currentTarget.value)} />
              <div class="remote-level">
                <SegmentedControl
                  aria-label={t("remote.pair.mayDo")}
                  size="sm"
                  options={[
                    { value: "view" as Capability, label: t("remote.cap.view") },
                    { value: "reply" as Capability, label: t("remote.cap.reply") },
                  ]}
                  value={cap()}
                  onChange={setCap}
                />
                <p class="remote-note">{t("remote.pair.levelNote")}</p>
              </div>
            </div>
          )}
        </Show>
        <Show when={problem()}>
          <p class="remote-problem" role="alert">
            {problem()}
          </p>
        </Show>
        <Show when={busy() && !offer()}>
          <Spinner size={16} />
        </Show>
      </div>
    </Dialog>
  );
}
