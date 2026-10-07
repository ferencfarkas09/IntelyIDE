import type { TabInstance } from "../../platform/tabs";
import { PreviewView } from "./PreviewView";

/** The centre tab: one per repo (`preview:<repoId>`). */
export default function PreviewTab(props: { tab: TabInstance }) {
  return <PreviewView repoId={String(props.tab.params?.repoId ?? "")} mode="tab" />;
}
