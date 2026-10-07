import { render } from "solid-js/web";
import { initTheme } from "../../theme/theme";
import { Gallery } from "./Gallery";

export function mountGallery(root: HTMLElement) {
  initTheme();
  render(() => <Gallery />, root);
}
