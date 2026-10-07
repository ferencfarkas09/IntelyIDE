import { FormGroup, FormRow, Select, Switch } from "../../ui-kit";
import { t } from "../../i18n";
import { normalizeEditor, NS, type EditorSettings } from "./model";
import { useNamespace } from "./namespace";
import "./settings-core.css";

export default function EditorSection() {
  const editor = useNamespace(NS.editor, normalizeEditor);
  const tabSizes = () => ["2", "4", "8"].map((v) => ({ value: v, label: t("editorSet.spaces", { n: v }) }));
  const set = (patch: Partial<EditorSettings>) => void editor.update(patch);
  return (
    <div class="sc-section">
      <FormGroup>
        <FormRow label={t("editorSet.tabSize")} description={t("editorSet.tabSizeDesc")}>
          <Select size="sm" aria-label={t("editorSet.tabSize")} options={tabSizes()} value={String(editor.value().tabSize)} onChange={(v) => set({ tabSize: Number(v) as EditorSettings["tabSize"] })} />
        </FormRow>
        <FormRow label={t("editorSet.softWrap")} description={t("editorSet.softWrapDesc")}>
          <Switch aria-label={t("editorSet.softWrap")} checked={editor.value().softWrap} onChange={(softWrap) => set({ softWrap })} />
        </FormRow>
        <FormRow label={t("editorSet.lineNumbers")}>
          <Switch aria-label={t("editorSet.lineNumbers")} checked={editor.value().lineNumbers} onChange={(lineNumbers) => set({ lineNumbers })} />
        </FormRow>
      </FormGroup>
    </div>
  );
}
