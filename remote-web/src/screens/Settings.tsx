import { createResource, createSignal, For, Show } from "solid-js";
import { Badge } from "@ui/ui-kit/Badge";
import { Button } from "@ui/ui-kit/Button";
import { Icon } from "@ui/ui-kit/Icon";
import { Switch } from "@ui/ui-kit/Switch";
import { CircleAlert, KeyRound, Laptop, Lock, RefreshCw, ShieldCheck, Smartphone } from "@ui/ui-kit/icons";
import { canReply, sendRelayControl, signOut, state, stopAll } from "../core/app";
import { bundleInfo, groupHash, seqDate } from "../core/bundle";
import { enablePush, loadPrefs, pushConfirmedAt, pushSupported, savePrefs, type PushResult } from "../core/push";
import { BottomSheet } from "../ui/BottomSheet";
import { ConnChip } from "../ui/ConnChip";
import { clock } from "../ui/format";
import { activatePending, pinState, refreshPinState, resetThisApp, shellState } from "../sw/page";

const WHY: Record<string, string> = {
  keyChanged: "This build is signed with a different key than the one your Mac gave this phone.",
  badSignature: "The signature of this build is not valid.",
  rollback: "This build is older than one this phone already accepted.",
};

/** Red banner for a build that failed its check, and for a phone that has no (or lost its) build key. English literals: the PWA has no i18n yet. */
export function IntegrityBanner() {
  return (
    <>
      <Show when={state.integrity !== "ok"}>
        <div class="error-card error-card--banner" role="alert" data-testid="integrity-banner">
          <Icon icon={CircleAlert} size={20} />
          <div>
            <strong>This app build was refused</strong>
            <p>
              {WHY[state.integrity]} The phone has stopped talking to your Mac. Open Devices and choose Reset this app, then pair again from the Mac. After a rollback in the Cloudflare dashboard, redeploy from IntelyIDE (that makes a new build number).
            </p>
          </div>
        </div>
      </Show>
      <Show when={state.integrity === "ok" && pinState().status === "pinLost"}>
        <div class="error-card error-card--banner" role="alert" data-testid="pin-lost-banner">
          <Icon icon={KeyRound} size={20} />
          <div>
            <strong>Build key lost</strong>
            <p>This phone paired with a build key but the stored copy is gone (iOS can clear app storage). The Mac sends it again when connected; until then updates are not checked against a signature.</p>
          </div>
        </div>
      </Show>
    </>
  );
}

export default function Settings() {
  const [bundle] = createResource(() => bundleInfo());
  const [prefs, setPrefs] = createSignal(loadPrefs());
  const [confirm, setConfirm] = createSignal<"signout" | "stopall" | "reset" | null>(null);
  const [push, setPush] = createSignal<PushResult | null>(null);
  const [note, setNote] = createSignal<string | null>(null);
  void refreshPinState();
  const shellFail = () => {
    const s = shellState();
    return s.k === "failed" && s.reason !== "network" ? s : null;
  };
  const pendingBuild = () => {
    const s = shellState();
    return s.k === "ok" && s.pending ? s : null;
  };
  const set = (k: keyof ReturnType<typeof loadPrefs>, v: boolean) => {
    const next = { ...prefs(), [k]: v };
    setPrefs(next);
    savePrefs(next);
  };
  const confirmedAt = () => pushConfirmedAt();

  return (
    <main class="screen">
      <header class="topbar">
        <div>
          <h1 class="topbar__title">Devices &amp; settings</h1>
          <p class="topbar__sub">{state.macName}</p>
        </div>
        <ConnChip />
      </header>
      <div class="scroller pad">
        <section class="panel" data-testid="this-device">
          <h2>
            <Icon icon={Smartphone} size={16} /> This device
          </h2>
          <dl class="kv">
            <dt>Name</dt>
            <dd>{state.device?.name ?? "This phone"}</dd>
            <dt>Level</dt>
            <dd data-testid="capability">
              <Badge tone={state.capability === "reply" ? "accent" : "neutral"} icon={state.capability === "reply" ? ShieldCheck : Lock}>
                {state.capability === "reply" ? (state.reauthRequired ? "Reply (passkey check needed)" : "Reply") : "View only"}
              </Badge>
            </dd>
            <dt>Build</dt>
            <dd class="mono small" data-testid="build-hash">
              <Show when={bundle()?.hash} fallback="unsigned build">
                {groupHash(bundle()!.hash!.slice(0, 16))}
              </Show>
            </dd>
            <dt>Build key</dt>
            <dd data-testid="pin-state">
              <Show when={pinState().status === "pinned"}>
                <Badge tone="ok" icon={KeyRound}>
                  Pinned
                </Badge>{" "}
                <span class="mono small" data-testid="pin-fingerprint">
                  {pinState().fingerprint}
                </span>
              </Show>
              <Show when={pinState().status === "unpinned"}>
                <Badge tone="danger" icon={CircleAlert}>
                  Code source not verified
                </Badge>
              </Show>
              <Show when={pinState().status === "pinLost"}>
                <Badge tone="danger" icon={CircleAlert}>
                  Pin lost
                </Badge>
              </Show>
            </dd>
            <Show when={seqDate(bundle()?.seq ?? null)}>
              <dt>Built</dt>
              <dd class="small" data-testid="build-date">
                {seqDate(bundle()!.seq)!.toLocaleString()}
              </dd>
            </Show>
            <Show when={state.device?.bundleHash && bundle()?.hash && state.device.bundleHash !== bundle()!.hash}>
              <dt>Update</dt>
              <dd>
                <Badge tone="warn" icon={CircleAlert}>
                  New build since pairing: compare the hash with your Mac again
                </Badge>
              </dd>
            </Show>
          </dl>
          <Show when={pinState().status === "unpinned"}>
            <p class="problem" role="alert" data-testid="unverified-note">
              This phone has no build key from your Mac, so the app code is not checked against a signature and the hash compare at pairing proves little. On the Mac use Send my build key to paired phones.
            </p>
          </Show>
          <Show when={pinState().keyRotated}>
            <p class="muted small">Your Mac replaced the build key after a rotation. This phone now trusts the new one.</p>
          </Show>
          <Show when={shellFail()}>
            {(f) => (
              <p class="problem" role="alert" data-testid="shell-failed">
                <Icon icon={CircleAlert} size={14} /> The newest app build was not installed ({f().reason}). The verified copy on this phone keeps running.
              </p>
            )}
          </Show>
          <Show when={pendingBuild()}>
            <Button size="lg" fullWidth variant="primary" icon={RefreshCw} data-testid="reload-verified" onClick={() => void activatePending()}>
              {pinState().status === "unpinned" ? "New build ready (hashes match, no signature key on this phone), reload" : "New build verified, reload"}
            </Button>
          </Show>
          <p class="muted small">Levels, revoking this device and the panic action live on your Mac: Settings &gt; Remote.</p>
        </section>

        <section class="panel">
          <h2>Notifications</h2>
          <p class="muted small">Pushes never contain run content. Tapping one opens the card inside the app.</p>
          <For each={[["needsYou", "Needs you"], ["finished", "Finished"], ["failed", "Failed"]] as const}>
            {([k, label]) => (
              <div class="setting">
                <span>{label}</span>
                <Switch checked={prefs()[k]} onChange={(v) => set(k, v)} aria-label={label} />
              </div>
            )}
          </For>
          <div class="setting">
            <span>
              Require Face ID for risky approvals <span class="muted small">(always on)</span>
            </span>
            <Switch checked disabled aria-label="Require Face ID for risky approvals" />
          </div>
          <Button
            size="lg"
            fullWidth
            disabled={!pushSupported()}
            onClick={async () => setPush(await enablePush((c) => sendRelayControl(c)))}
            data-testid="enable-push"
          >
            Turn on push on this device
          </Button>
          <p class="muted small" data-testid="push-state">
            {push()?.message ?? (!pushSupported() ? "Push is not available in this browser." : confirmedAt() ? `Push last confirmed ${clock(confirmedAt()!)}` : "Push not set up.")}
          </p>
        </section>

        <section class="panel">
          <h2>
            <Icon icon={Laptop} size={16} /> Your Mac
          </h2>
          <dl class="kv">
            <dt>Status</dt>
            <dd>
              <ConnChip />
            </dd>
            <Show when={state.macLastSeen}>
              <dt>Last seen</dt>
              <dd>{clock(state.macLastSeen!)}</dd>
            </Show>
          </dl>
          <Button size="lg" fullWidth variant="danger" disabled={!canReply() || state.conn !== "live"} onClick={() => setConfirm("stopall")} data-testid="stop-all">
            Stop all runs
          </Button>
        </section>

        <section class="panel">
          <h2>Reset this app</h2>
          <p class="muted small">Removes the app copy stored on this phone (service worker, cache, build key) and everything else it keeps. You pair again afterwards. Use it when a red banner says this build was refused.</p>
          <Button size="lg" fullWidth variant="secondary" onClick={() => setConfirm("reset")} data-testid="reset-app">
            Reset this app
          </Button>
        </section>

        <section class="panel">
          <h2>Sign out</h2>
          <p class="muted small">Removes this phone from the Mac and erases the keys and cache stored here.</p>
          <Button size="lg" fullWidth variant="secondary" onClick={() => setConfirm("signout")} data-testid="sign-out">
            Sign out this device
          </Button>
        </section>
        <Show when={note()}>
          <p class="problem" role="alert">
            {note()}
          </p>
        </Show>
      </div>

      <BottomSheet open={confirm() === "signout"} onClose={() => setConfirm(null)} title="Sign out this device?">
        <p>You will need to pair again with a new code from your Mac.</p>
        <div class="sheet__actions">
          <Button size="lg" variant="danger" data-testid="sign-out-confirm" onClick={() => void signOut()}>
            Sign out
          </Button>
          <Button size="lg" variant="ghost" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
        </div>
      </BottomSheet>
      <BottomSheet open={confirm() === "reset"} onClose={() => setConfirm(null)} title="Reset this app?">
        <p>The saved app files, the build key and your pairing are deleted from this phone. Remove the phone on the Mac as well if you will not use it again.</p>
        <div class="sheet__actions">
          <Button size="lg" variant="danger" data-testid="reset-app-confirm" onClick={() => void resetThisApp()}>
            Reset this app
          </Button>
          <Button size="lg" variant="ghost" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
        </div>
      </BottomSheet>
      <BottomSheet open={confirm() === "stopall"} onClose={() => setConfirm(null)} title="Stop all runs?">
        <p>Every running agent stops after its current step.</p>
        <div class="sheet__actions">
          <Button
            size="lg"
            variant="danger"
            data-testid="stop-all-confirm"
            onClick={async () => {
              setConfirm(null);
              setNote(await stopAll());
            }}
          >
            Stop all runs
          </Button>
          <Button size="lg" variant="ghost" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
        </div>
      </BottomSheet>
    </main>
  );
}
