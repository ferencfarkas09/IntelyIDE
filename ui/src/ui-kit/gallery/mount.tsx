import { render } from "solid-js/web";
import { initTheme } from "../../theme/theme";
import { pinSkinFromUrl } from "../../theme/skin";
import { Gallery } from "./Gallery";

export function mountGallery(root: HTMLElement) {
  initTheme();
  pinSkinFromUrl(location.search, document.documentElement, false);
  render(() => <Gallery />, root);
}
