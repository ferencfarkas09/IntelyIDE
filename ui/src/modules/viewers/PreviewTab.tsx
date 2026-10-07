import type { TabInstance } from "../../platform/tabs";
import { PreviewBody } from "./PreviewBody";

/** Tab type `docview`: the preview of one file in its own tab. */
export default function PreviewTab(props: { tab: TabInstance }) {
  const p = () => props.tab.params as { repoId: string; path: string };
  return (
    <div class="pvw">
      <PreviewBody file={{ repoId: p().repoId, path: p().path }} />
    </div>
  );
}
