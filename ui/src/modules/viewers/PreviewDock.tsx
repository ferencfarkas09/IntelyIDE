import { PreviewBody } from "./PreviewBody";
import { activePreviewFile } from "./state";

/** "Preview beside the editor": a dock tab that follows the file of the active editor tab and re-renders when it is saved. */
export default function PreviewDock() {
  return (
    <div class="pvw">
      <PreviewBody file={activePreviewFile()} />
    </div>
  );
}
