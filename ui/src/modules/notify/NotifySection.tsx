import { For } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { FormGroup, FormRow, Select, Switch } from "../../ui-kit";
import { THROTTLE_SECONDS, type NotifySettings } from "./logic";
import { applyNotifySettings, notifySettings } from "./state";

const KINDS = ["permission", "question", "finished", "error"] as const;
const throttleOptions = () => THROTTLE_SECONDS.map((s) => ({ value: String(s), label: t("hud.seconds", { n: s }) }));

/** Settings > Notifications. Banners appear only while the IDE window is in the background. */
export default function NotifySection() {
  const set = (patch: Partial<NotifySettings>) => {
    applyNotifySettings({ ...notifySettings(), ...patch });
    void ipc.settings.set("notify", patch);
  };
  return (
    <div>
      <FormGroup title={t("notify.group.banners")}>
        <FormRow label={t("notify.master")} description={t("notify.masterDesc")}>
          <Switch checked={notifySettings().enabled} onChange={(enabled) => set({ enabled })} aria-label={t("notify.master")} />
        </FormRow>
        <For each={KINDS}>
          {(k) => (
            <FormRow label={t("hud.notifyLabel", { kind: t(`hud.kind.${k}.label`) })} description={t(`hud.kind.${k}.desc`)}>
              <Switch checked={notifySettings()[k]} onChange={(v) => set({ [k]: v })} aria-label={t("hud.notifyAria", { kind: t(`hud.kind.${k}.label`).toLowerCase() })} disabled={!notifySettings().enabled} />
            </FormRow>
          )}
        </For>
        <FormRow label={t("hud.throttle")} description={t("hud.throttleDesc")}>
          <Select size="sm" aria-label={t("hud.throttleAria")} options={throttleOptions()} value={String(notifySettings().throttleSeconds)} disabled={!notifySettings().enabled} onChange={(v) => set({ throttleSeconds: Number(v) })} />
        </FormRow>
        <FormRow label={t("notify.sound")} description={t("notify.soundDesc")}>
          <Switch checked={notifySettings().sound} onChange={(sound) => set({ sound })} aria-label={t("notify.sound")} disabled={!notifySettings().enabled} />
        </FormRow>
      </FormGroup>
      <FormGroup title={t("notify.group.dock")}>
        <FormRow label={t("notify.badge")} description={t("notify.badgeDesc")}>
          <Switch checked={notifySettings().badge} onChange={(badge) => set({ badge })} aria-label={t("notify.badge")} disabled={!notifySettings().enabled} />
        </FormRow>
      </FormGroup>
    </div>
  );
}
