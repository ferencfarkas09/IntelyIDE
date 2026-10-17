import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { fmt, locale, t } from "../../i18n";
import { ipc } from "../../ipc";
import { ABOUT } from "../../shell/aboutText";
import { registry } from "../../store/workspaces";
import { Badge, Button, Dialog, Icon, Sparkles, toast, type Tone } from "../../ui-kit";
import { decide, pick, releasesToShow, RELEASES, type NoteKind, type Release } from "./logic";
import { appVersion, closeWhatsNew, rememberVersion, seenVersion, showUpdate, whatsNewView } from "./state";
import "./whatsnew.css";

const KIND_TONE: Record<NoteKind, Tone> = { new: "accent", improved: "info", fixed: "ok" };
const KIND_LABEL = { new: "whatsnew.kind.new", improved: "whatsnew.kind.improved", fixed: "whatsnew.kind.fixed" } as const;

/** Wait before the window opens, so the shell has settled and the window does not fight the first paint. */
const SETTLE_MS = 700;

const dateOf = (iso: string): string => {
  const at = Date.parse(`${iso}T12:00:00Z`);
  return Number.isNaN(at) ? iso : fmt.date(at);
};

function ReleaseBlock(props: { release: Release; open: boolean; lead: boolean }) {
  const [expanded, setExpanded] = createSignal(props.open);
  return (
    <section class="wn__release" aria-label={t("whatsnew.version", { version: props.release.version })}>
      <button type="button" class="wn__head" aria-expanded={expanded()} onClick={() => setExpanded(!expanded())}>
        <span class="wn__version ui-tnum">{props.release.version}</span>
        <span class="wn__date">{dateOf(props.release.date)}</span>
        <Show when={!props.lead}>
          <span class="wn__headline">{pick(props.release.headline, locale())}</span>
        </Show>
      </button>
      <Show when={expanded()}>
        <ul class="wn__notes">
          <For each={props.release.notes}>
            {(note) => (
              <li class="wn__note" data-kind={note.kind}>
                <div class="wn__top">
                  <Badge size="sm" tone={KIND_TONE[note.kind]}>
                    {t(KIND_LABEL[note.kind])}
                  </Badge>
                  <h4 class="wn__title">{pick(note.title, locale())}</h4>
                </div>
                <p class="wn__text">{pick(note.text, locale())}</p>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}

/** Overlay: decides once at start whether the app was just updated, and shows the window for it. Also the window that the command opens. */
export default function WhatsNew() {
  let decided = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  // The registry tells a first start (empty: the Welcome screen is up) from a start of an app that has been used; it answers after boot.
  createEffect(() => {
    const reg = registry();
    if (!reg || decided) return;
    decided = true;
    void (async () => {
      const [current, safety] = await Promise.all([appVersion(), ipc.settings.safetyStatus().catch(() => undefined)]);
      const seen = seenVersion();
      const news = current ? releasesToShow(RELEASES, seen, current).length : 0;
      const verdict = decide({ seen, current, freshInstall: reg.workspaces.length === 0, jailOff: safety?.jail === "off", news });
      if (!current || verdict === "none") return;
      if (verdict === "remember") return rememberVersion(current);
      timer = setTimeout(() => showUpdate(current, seen), SETTLE_MS);
    })();
  });

  const open = () => whatsNewView();
  const first = () => open()?.releases[0];
  const changelog = async () => {
    const view = open();
    if (!view || !ABOUT.source) return;
    try {
      await ipc.happy.openExternal(`${ABOUT.source}/releases/tag/v${first()?.version ?? view.current}`);
    } catch (e) {
      toast.error((e as { message?: string }).message ?? t("whatsnew.openFailed"));
    }
  };
  return (
    <Dialog
      open={!!open()}
      onClose={closeWhatsNew}
      size="lg"
      class="wn"
      title={t("whatsnew.title", { version: first()?.version ?? open()?.current ?? "" })}
      description={open()?.from ? t("whatsnew.updatedFrom", { from: open()!.from! }) : t("whatsnew.latest")}
      footer={
        <>
          <Show when={ABOUT.source}>
            <Button variant="ghost" onClick={() => void changelog()}>
              {t("whatsnew.changelog")}
            </Button>
          </Show>
          <Button variant="primary" data-autofocus onClick={closeWhatsNew}>
            {t("whatsnew.gotIt")}
          </Button>
        </>
      }
    >
      <Show when={open()}>
        {(view) => (
          <div class="wn__list">
            <Show when={first()}>
              {(release) => (
                <p class="wn__lead">
                  <Icon icon={Sparkles} size={16} />
                  {pick(release().headline, locale())}
                </p>
              )}
            </Show>
            <For each={view().releases}>{(release, i) => <ReleaseBlock release={release} lead={i() === 0} open={i() === 0 || view().releases.length <= 2} />}</For>
          </div>
        )}
      </Show>
    </Dialog>
  );
}
