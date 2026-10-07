// Image lightbox: one global instance (mounted as an overlay); the composer chips and the transcript open it.
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { IconButton, X } from "../../ui-kit";
import { t } from "../../i18n";

export interface LightboxImage {
  src: string;
  name: string;
  detail?: string;
}

const [image, setImage] = createSignal<LightboxImage | null>(null);
export const lightboxImage = image;
export const openLightbox = (img: LightboxImage): void => void setImage(img);
export const closeLightbox = (): void => void setImage(null);

export default function Lightbox() {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && image()) {
      e.preventDefault();
      e.stopPropagation();
      closeLightbox();
    }
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));
  return (
    <Show when={image()}>
      {(img) => (
        <div class="att-lightbox" role="dialog" aria-modal="true" aria-label={t("attach.previewOf", { name: img().name })} data-testid="att-lightbox" onClick={closeLightbox}>
          <div class="att-lightbox__bar" onClick={(e) => e.stopPropagation()}>
            <span class="att-lightbox__name ui-truncate">{img().name}</span>
            <Show when={img().detail}>
              <span class="att-lightbox__detail">{img().detail}</span>
            </Show>
            <IconButton icon={X} label={t("attach.closePreview")} shortcut={["Esc"]} onClick={closeLightbox} autofocus />
          </div>
          <img class="att-lightbox__img" src={img().src} alt={img().name} onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </Show>
  );
}
