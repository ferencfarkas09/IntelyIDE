// Entry of the radar window (`?widget=radar`): the theme and appearance from the shared mirror, the agent store, and the radar.
// No workspace UI, no modules, no keymap: the window only shows and answers what waits on the person.
import { render } from "solid-js/web";
import { startAgentStore } from "../../../store/agents";
import { pinSkinFromUrl } from "../../../theme/skin";
import { Announcer, initTheme, Toaster } from "../../../ui-kit";
import { applyAppearance, readMirror } from "../../settings-core/appearance";
import { Radar } from "./Radar";

export function mountRadar(root: HTMLElement): () => void {
  initTheme();
  applyAppearance(readMirror());
  pinSkinFromUrl();
  document.documentElement.dataset.window = "radar";
  return render(() => {
    startAgentStore();
    return (
      <>
        <Radar />
        <Toaster placement="bottom-right" />
        <Announcer />
      </>
    );
  }, root);
}
