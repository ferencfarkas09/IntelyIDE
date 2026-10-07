import { createResource, onMount } from "solid-js";
import { fmt, t } from "../../i18n";
import { tRich } from "../../components/richText";
import { ipc } from "../../ipc";
import { FormGroup, FormRow, Select, Switch, type SelectOption } from "../../ui-kit";
import { DEVICES, deviceName, FRAME_SRC } from "./logic";
import { componentPreviewEnabled, setComponentPreviewEnabled, syncComponentPreviewEnabled } from "./toggle";
import "./preview.css";

const options = (): SelectOption<string>[] => DEVICES.filter((d) => d.kind !== "custom").map((d) => ({ value: d.id, label: deviceName(d) }));

/** Settings > Preview: the default device for a repo that has no saved preview yet, and the rule the frame follows. */
export default function PreviewSettings() {
  const [ns, { mutate }] = createResource(() => ipc.settings.get("preview"));
  const device = () => (typeof ns()?.defaultDevice === "string" ? (ns()!.defaultDevice as string) : "fluid");
  const set = (defaultDevice: string) => {
    mutate((v) => ({ ...v, defaultDevice }));
    void ipc.settings.set("preview", { defaultDevice });
  };
  onMount(() => void syncComponentPreviewEnabled());
  return (
    <div class="pv-settings">
      <FormGroup>
        <FormRow label={t("pv.settings.device.label")} description={t("pv.settings.device.desc")}>
          <Select size="sm" aria-label={t("pv.settings.device.label")} options={options()} value={device()} onChange={set} />
        </FormRow>
        <FormRow label={t("pvc.settings.label")} description={t("pvc.settings.desc")}>
          <Switch aria-label={t("pvc.settings.label")} checked={componentPreviewEnabled()} onChange={setComponentPreviewEnabled} />
        </FormRow>
      </FormGroup>
      <p>
        {tRich("pv.settings.note", { a: <code>http://localhost</code>, b: <code>http://127.0.0.1</code>, c: <code>http://[::1]</code> }, { csp: fmt.list([...FRAME_SRC]) })}
      </p>
    </div>
  );
}
