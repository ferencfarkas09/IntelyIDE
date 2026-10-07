import { createSignal, For, Show, type Component } from "solid-js";
import { t } from "../../../i18n";
import { ipc } from "../../../ipc";
import type { LocalHit } from "../../../ipc/mongo";
import { Braces, Button, CircleCheck, CloudDownload, Copy, Info, KeyRound, Laptop, Lock, Search, Server, toast, type LucideIcon } from "../../../ui-kit";
import type { StartingPoint } from "../logic";
import { messageOf } from "../store";
import "../manage.css";

export const DOCKER_SNIPPET = "docker run -d --name mongo-try -p 127.0.0.1:27017:27017 mongo:7";

interface Tile {
  kind: StartingPoint;
  icon: LucideIcon;
}
const TILES: readonly Tile[] = [
  { kind: "atlas", icon: CloudDownload },
  { kind: "local", icon: Laptop },
  { kind: "network", icon: Server },
  { kind: "ssh", icon: KeyRound },
  { kind: "string", icon: Braces },
];

export interface FirstRunProps {
  /** A starting point was chosen; `hit` pre-fills the loopback address the probe found. */
  onPick: (kind: StartingPoint, hit?: LocalHit) => void;
  /** "Not now": collapse to the normal empty state and remember it. */
  onDismiss: () => void;
}

/** S2: five starting points and one honest line. The loopback probe runs only when its button is clicked (spec 5.12). */
export const FirstRun: Component<FirstRunProps> = (props) => {
  const [hits, setHits] = createSignal<LocalHit[]>();
  const [probing, setProbing] = createSignal(false);
  const [probeError, setProbeError] = createSignal<string>();

  async function probe() {
    setProbing(true);
    setProbeError(undefined);
    try {
      setHits(await ipc.mongo.detectLocal());
    } catch (e) {
      setHits(undefined);
      setProbeError(messageOf(e));
    } finally {
      setProbing(false);
    }
  }
  const copy = () => void navigator.clipboard?.writeText(DOCKER_SNIPPET).then(() => toast.info(t("mongoManage.first.copied")));

  return (
    <section class="mm-first" aria-labelledby="mm-first-h">
      <header class="mm-first__head">
        <h3 id="mm-first-h" class="mm-first__title">{t("mongoManage.first.title")}</h3>
        <p class="mm-first__line"><Lock size={13} aria-hidden="true" /> {t("mongoManage.first.line")}</p>
      </header>
      <ul class="mm-tiles" aria-label={t("mongoManage.first.tiles")}>
        <For each={TILES}>
          {(tile) => (
            <li class="mm-tile">
              <span class="mm-tile__icon" aria-hidden="true"><tile.icon size={18} /></span>
              <h4 class="mm-tile__title">{t(`mongoManage.tile.${tile.kind}.title`)}</h4>
              <p class="mm-tile__desc">{t(`mongoManage.tile.${tile.kind}.desc`)}</p>
              <Show when={tile.kind === "local"}>
                <div class="mm-probe">
                  <Button size="sm" variant="secondary" icon={Search} loading={probing()} onClick={() => void probe()}>{t("mongoManage.first.look")}</Button>
                  <div aria-live="polite" class="mm-probe__out">
                    <Show when={hits()}>
                      {(h) => (
                        <Show
                          when={h().length}
                          fallback={
                            <div class="mm-probe__none">
                              <p class="mm-hint"><Info size={12} aria-hidden="true" /> {t("mongoManage.first.none")}</p>
                              <div class="mm-snippet"><code dir="ltr">{DOCKER_SNIPPET}</code><Button size="sm" variant="ghost" icon={Copy} aria-label={t("mongoManage.first.copy")} onClick={copy} /></div>
                            </div>
                          }
                        >
                          <For each={h()}>
                            {(hit) => (
                              <Button size="sm" variant="ghost" icon={CircleCheck} onClick={() => props.onPick("local", hit)}>{t("mongoManage.first.found", { host: hit.host, port: String(hit.port) })}</Button>
                            )}
                          </For>
                        </Show>
                      )}
                    </Show>
                    <Show when={probeError()}><p class="mm-hint" role="alert">{probeError()}</p></Show>
                  </div>
                </div>
              </Show>
              <Button size="sm" variant={tile.kind === "atlas" ? "primary" : "secondary"} class="mm-tile__go" aria-label={t(`mongoManage.tile.${tile.kind}.title`)} onClick={() => props.onPick(tile.kind)}>{t("mongoManage.first.start")}</Button>
            </li>
          )}
        </For>
      </ul>
      <div class="mm-first__foot">
        <Button size="sm" variant="ghost" onClick={props.onDismiss}>{t("mongoManage.first.notNow")}</Button>
      </div>
    </section>
  );
};
