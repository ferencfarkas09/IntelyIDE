import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { Button } from "@ui/ui-kit/Button";
import { Badge } from "@ui/ui-kit/Badge";
import { Icon } from "@ui/ui-kit/Icon";
import { Spinner } from "@ui/ui-kit/Spinner";
import { CircleAlert, CircleCheck, Smartphone, ShieldCheck, TriangleAlert } from "@ui/ui-kit/icons";
import { paired } from "../core/app";
import { bundleInfo, groupHash, isOk } from "../core/bundle";
import { parseManualCode, parseOffer, type Offer } from "../core/code";
import { pair, PairError, type PairStep } from "../core/pairing";
import { wsBase } from "../core/relay";
import { pinFromMac } from "../sw/page";

const isStandalone = (): boolean => (navigator as unknown as { standalone?: boolean }).standalone === true || matchMedia("(display-mode: standalone)").matches;

export function defaultDeviceName(ua = navigator.userAgent): string {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  return "Phone";
}

/** The pairing link may already be in the address bar (opened from the Camera app); read it once and clear it. */
export function takeFragmentOffer(): Offer | null {
  const o = parseOffer(location.hash);
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  return o;
}

type Phase = { k: "intro" } | { k: "scan" } | { k: "pairing"; step: PairStep; sas: string | null } | { k: "error"; message: string; code: string };

export default function Onboarding(props: { initialOffer?: Offer | null }) {
  const [bundle] = createResource(() => bundleInfo());
  const [name, setName] = createSignal(defaultDeviceName());
  const [phase, setPhase] = createSignal<Phase>({ k: "intro" });
  const [paste, setPaste] = createSignal("");
  const [problem, setProblem] = createSignal<string | null>(null);
  const [offer, setOffer] = createSignal<Offer | null>(props.initialOffer ?? null);
  let abort: AbortController | null = null;
  onCleanup(() => abort?.abort());

  const start = async (o: Offer) => {
    if (o.relayHost !== location.host) {
      setProblem(`This code is for another relay (${o.relayHost}). Open that address on your phone instead.`);
      return;
    }
    setProblem(null);
    abort = new AbortController();
    setPhase({ k: "pairing", step: "connecting", sas: null });
    let welcomePub: string | null = null;
    try {
      const device = await pair({
        offer: o,
        deviceName: name().trim() || defaultDeviceName(),
        bundleHash: bundle()?.hash ?? null,
        signal: abort.signal,
        base: wsBase(),
        hooks: {
          onStep: (step) => setPhase((p) => (p.k === "pairing" ? { ...p, step } : p)),
          onSas: (sas) => setPhase((p) => (p.k === "pairing" ? { ...p, sas } : p)),
          onWelcome: (pub) => void (welcomePub = pub),
        },
      });
      // The pin is written only now: SAS accepted, the Mac accepted this device, the device record is in hand.
      if (welcomePub) await pinFromMac(welcomePub);
      paired(device);
    } catch (e) {
      const pe = e as PairError;
      setPhase({ k: "error", message: pe.message, code: pe.code ?? "network" });
    }
  };

  const submitPaste = () => {
    const text = paste().trim();
    const o = parseOffer(text);
    if (o) return void start(o);
    if (parseManualCode(text)) setProblem("That is the short code. This build needs the whole pairing link from the Mac (Copy link), because the code alone does not say which Mac it belongs to.");
    else setProblem("That does not look like a pairing link. On the Mac choose Pair device and copy the link or scan the QR.");
  };

  return (
    <main class="screen onboarding">
      <header class="hero">
        <span class="hero__icon">
          <Icon icon={Smartphone} size={24} />
        </span>
        <h1>IntelyIDE Remote</h1>
        <p class="muted">Watch your agent runs, answer questions and approve safe actions from your phone. Everything between your phone and your Mac is end-to-end encrypted.</p>
      </header>

      <Show when={phase().k === "intro" || phase().k === "scan" || phase().k === "error"}>
        <ol class="steps">
          <li class="step">
            <h2>
              <span class="step__n">1</span> Add to Home Screen
              <Show when={isStandalone()}>
                <Badge tone="ok" icon={CircleCheck}>
                  Installed
                </Badge>
              </Show>
            </h2>
            <p class="muted">In Safari tap Share, then Add to Home Screen, and open IntelyIDE from there. Safari and the installed app keep separate data, so pair in the installed app.</p>
          </li>
          <li class="step" data-testid="bundle-step">
            <h2>
              <span class="step__n">2</span> Compare the build
            </h2>
            <Show when={bundle()} fallback={<p class="muted">Checking the app files…</p>}>
              {(b) => (
                <>
                  <Show when={b().hash} fallback={<Badge tone="warn" icon={TriangleAlert}>No signed manifest</Badge>}>
                    <p class="hash" data-testid="bundle-hash" aria-label="Running bundle hash">
                      {groupHash(b().hash!.slice(0, 16))}
                    </p>
                  </Show>
                  <Show when={isOk(b().state)}>
                    <Badge tone="ok" icon={ShieldCheck}>
                      {b().files} files match the manifest
                    </Badge>
                    <p class="muted small" data-testid="unpinned-note">
                      Your Mac gives this phone its build key while pairing; from then on every update of the app is checked against that key. Until then only the hash above protects the first load.
                    </p>
                  </Show>
                  <Show when={!isOk(b().state)}>
                    <Badge tone="danger" icon={CircleAlert}>
                      {b().detail ?? "Do not pair"}
                    </Badge>
                  </Show>
                  <p class="muted small">Settings &gt; Remote on your Mac shows the expected hash. If the first 16 digits differ, stop: the relay may be serving a different app.</p>
                </>
              )}
            </Show>
          </li>
          <li class="step">
            <h2>
              <span class="step__n">3</span> Scan the QR from your Mac
            </h2>
            <label class="field">
              <span>This device's name</span>
              <input class="text-input" value={name()} maxLength={40} onInput={(e) => setName(e.currentTarget.value)} autocomplete="off" />
            </label>
            <Show when={offer()}>
              {(o) => (
                <Button variant="primary" size="lg" fullWidth onClick={() => void start(o())}>
                  Pair with this Mac
                </Button>
              )}
            </Show>
            <Show when={!offer()}>
              <Scanner
                onOffer={(o) => {
                  setOffer(o);
                  void start(o);
                }}
                onProblem={setProblem}
              />
              <label class="field">
                <span>Or paste the pairing link</span>
                <textarea class="text-input" rows={2} placeholder="https://…/#p=…" value={paste()} onInput={(e) => setPaste(e.currentTarget.value)} autocapitalize="off" autocorrect="off" spellcheck={false} />
              </label>
              <Button variant="secondary" size="lg" fullWidth disabled={!paste().trim()} onClick={submitPaste}>
                Connect
              </Button>
            </Show>
            <Show when={problem()}>
              <p class="problem" role="alert">
                <Icon icon={CircleAlert} size={14} /> {problem()}
              </p>
            </Show>
          </li>
        </ol>
      </Show>

      <Show when={phase().k === "pairing" && (phase() as Extract<Phase, { k: "pairing" }>)}>
        {(p) => (
          <section class="compare" aria-live="polite">
            <Show when={!p().sas} fallback={<CompareCode sas={p().sas!} />}>
              <Spinner size={24} label="Connecting" />
              <p class="muted">Connecting to your Mac…</p>
            </Show>
          </section>
        )}
      </Show>

      <Show when={phase().k === "error" && (phase() as Extract<Phase, { k: "error" }>)}>
        {(p) => (
          <div class="error-card" role="alert" data-testid="pair-error">
            <Icon icon={CircleAlert} size={20} />
            <div>
              <strong>Pairing did not finish</strong>
              <p>{p().message}</p>
              <Button
                size="md"
                onClick={() => {
                  setOffer(null);
                  setPhase({ k: "intro" });
                }}
              >
                Try again
              </Button>
            </div>
          </div>
        )}
      </Show>
    </main>
  );
}

function CompareCode(props: { sas: string }) {
  return (
    <div class="compare__box">
      <p class="muted">Check this code matches the one on your Mac</p>
      <p class="sas" data-testid="sas" aria-label={`Code ${props.sas.split("").join(" ")}`}>
        {props.sas.slice(0, 3)} {props.sas.slice(3)}
      </p>
      <p class="waiting">
        <Spinner size={14} /> Waiting for you to approve on the Mac…
      </p>
      <p class="muted small">New devices start as view only. You choose what this phone may do on the Mac.</p>
    </div>
  );
}

/** QR scan in the app: BarcodeDetector + getUserMedia where the browser has them, otherwise only the paste field shows. */
function Scanner(props: { onOffer: (o: Offer) => void; onProblem: (m: string | null) => void }) {
  const supported = "BarcodeDetector" in globalThis && !!navigator.mediaDevices?.getUserMedia;
  const [on, setOn] = createSignal(false);
  let video: HTMLVideoElement | undefined;
  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer) clearInterval(timer);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    setOn(false);
  };
  onCleanup(stop);

  const begin = async () => {
    props.onProblem(null);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      setOn(true);
      queueMicrotask(async () => {
        if (!video || !stream) return;
        video.srcObject = stream;
        await video.play().catch(() => {});
        const Detector = (globalThis as unknown as { BarcodeDetector: new (o: { formats: string[] }) => { detect(v: HTMLVideoElement): Promise<{ rawValue: string }[]> } }).BarcodeDetector;
        const det = new Detector({ formats: ["qr_code"] });
        timer = setInterval(async () => {
          if (!video) return;
          const hits = await det.detect(video).catch(() => []);
          for (const h of hits) {
            const o = parseOffer(h.rawValue);
            if (o) {
              stop();
              return props.onOffer(o);
            }
          }
        }, 250);
      });
    } catch {
      props.onProblem("The camera is not available. Allow camera access, or paste the pairing link below.");
    }
  };

  return (
    <Show when={supported} fallback={<p class="muted small">This browser cannot scan QR codes here. Paste the pairing link below.</p>}>
      <Show when={on()} fallback={<Button variant="primary" size="lg" fullWidth onClick={() => void begin()}>Scan QR in the app</Button>}>
        <div class="scanner">
          <video ref={video} playsinline muted />
          <Button size="md" onClick={stop}>
            Cancel scan
          </Button>
        </div>
      </Show>
    </Show>
  );
}
