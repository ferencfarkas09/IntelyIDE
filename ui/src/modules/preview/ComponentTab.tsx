import type { TabInstance } from "../../platform/tabs";
import { ComponentView } from "./ComponentView";

/** The centre tab: one per component file (`previewc:<repoId>:<path>`). */
export default function ComponentTab(props: { tab: TabInstance }) {
  return <ComponentView repoId={String(props.tab.params?.repoId ?? "")} path={String(props.tab.params?.path ?? "")} exportName={typeof props.tab.params?.export === "string" ? props.tab.params.export : undefined} />;
}
