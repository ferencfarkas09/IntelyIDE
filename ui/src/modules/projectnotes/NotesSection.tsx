import { onMount } from "solid-js";
import { t } from "../../i18n";
import { FormGroup, FormRow, Switch } from "../../ui-kit";
import { projectNotesEnabled, setProjectNotesEnabled, syncProjectNotesEnabled } from "./toggle";

/** Settings section: the toggle that shows the Project notes panel and its commands. */
export default function NotesSection() {
  onMount(() => void syncProjectNotesEnabled());
  return (
    <FormGroup title={t("pnotes.section.title")} description={t("pnotes.section.desc")}>
      <FormRow label={t("pnotes.section.enable")} description={t("pnotes.section.enableDesc")}>
        <Switch checked={projectNotesEnabled()} onChange={setProjectNotesEnabled} aria-label={t("pnotes.section.enable")} />
      </FormRow>
    </FormGroup>
  );
}
