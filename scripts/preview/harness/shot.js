// Approximate snapshot of a DOM subtree as PNG: the subtree is cloned with every computed style inlined, wrapped in an
// SVG foreignObject and drawn on a canvas. No dependency, no network. Limits (honest): pseudo-elements, canvas and video
// content and form control state are not drawn; a browser that refuses to read pixels back from a foreignObject
// (WebKit may) makes this fail with a readable message instead of producing a blank image.
const MAX_NODES = 1500;
const MAX_SIDE = 4000;

function inlineStyles(src, dst, state) {
  if (++state.count > MAX_NODES) throw new Error(`The component has more than ${MAX_NODES} elements: too large for an in-page snapshot.`);
  const cs = getComputedStyle(src);
  let css = "";
  for (let i = 0; i < cs.length; i++) css += `${cs[i]}:${cs.getPropertyValue(cs[i])};`;
  dst.setAttribute("style", css);
  if (src instanceof HTMLImageElement && src.complete && src.naturalWidth > 0 && !src.src.startsWith("data:")) {
    try {
      const c = document.createElement("canvas");
      c.width = src.naturalWidth;
      c.height = src.naturalHeight;
      c.getContext("2d").drawImage(src, 0, 0);
      dst.setAttribute("src", c.toDataURL("image/png"));
    } catch {
      dst.removeAttribute("src");
    }
  }
  if (src instanceof HTMLInputElement) dst.setAttribute("value", src.value);
  if (src instanceof HTMLTextAreaElement) dst.textContent = src.value;
  const a = src.children;
  const b = dst.children;
  for (let i = 0; i < a.length; i++) if (b[i]) inlineStyles(a[i], b[i], state);
}

export async function snapshot(el, { scale = 1, background = "#ffffff" } = {}) {
  const rect = el.getBoundingClientRect();
  const w = Math.min(MAX_SIDE, Math.max(1, Math.ceil(rect.width)));
  const h = Math.min(MAX_SIDE, Math.max(1, Math.ceil(rect.height)));
  const clone = el.cloneNode(true);
  clone.querySelectorAll("script,style,link,noscript").forEach((n) => n.remove());
  inlineStyles(el, clone, { count: 0 });
  clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  const xml = new XMLSerializer().serializeToString(clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject x="0" y="0" width="${w}" height="${h}"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;background:${background};overflow:hidden">${xml}</div></foreignObject></svg>`;
  const img = new Image();
  img.decoding = "sync";
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("The browser could not draw the component into an image."));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0);
  try {
    return { dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
  } catch {
    throw new Error("This browser engine does not let a page read pixels back from the snapshot (a tainted canvas). Use the browser's own screenshot instead.");
  }
}
