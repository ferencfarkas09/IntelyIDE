import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { FormGroup, FormRow, Select, Switch } from "../../ui-kit";
import { ECO_MINUTES, type HudSettings, type TraySettings } from "./logic";
import { applyHudSettings, applyTraySettings, hudSettings, traySettings } from "./state";

const minutesOptions = () => ECO_MINUTES.map((m) => ({ value: String(m), label: t("hud.minutes", { n: m }) }));

/** Settings > Resources and menu bar. The watcher reacts to the saved values; every switch is off until you turn it on. */
export default function HudSettingsPage() {
  const setHud = (patch: Partial<HudSettings>) => {
    applyHudSettings({ ...hudSettings(), ...patch });
    void ipc.settings.set("hud", patch);
  };
  const setTray = (patch: Partial<TraySettings>) => {
    applyTraySettings({ ...traySettings(), ...patch });
    void ipc.settings.set("tray", patch);
  };
  return (
    <div>
      <FormGroup title={t("hud.monitor")}>
        <FormRow label={t("hud.showMem")} description={t("hud.showMemDesc")}>
          <Switch checked={hudSettings().enabled} onChange={(enabled) => setHud({ enabled })} aria-label={t("hud.showMem")} />
        </FormRow>
        <FormRow label={t("hud.eco")} description={t("hud.ecoDesc")}>
          <Switch checked={hudSettings().eco} onChange={(eco) => setHud({ eco })} aria-label={t("hud.eco")} />
        </FormRow>
        <FormRow label={t("hud.ecoStart")} description={t("hud.ecoStartDesc")}>
          <Select size="sm" aria-label={t("hud.ecoStart")} options={minutesOptions()} value={String(hudSettings().ecoMinutes)} disabled={!hudSettings().eco} onChange={(v) => setHud({ ecoMinutes: Number(v) })} />
        </FormRow>
      </FormGroup>
      <FormGroup title={t("hud.menuBar")}>
        <FormRow label={t("hud.tray")} description={t("hud.trayDesc")}>
          <Switch checked={traySettings().enabled} onChange={(enabled) => setTray({ enabled })} aria-label={t("hud.tray")} />
        </FormRow>
      </FormGroup>
    </div>
  );
}
