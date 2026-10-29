/**
 * The desktop platform the UI runs on, read once from the webview. `<html data-platform="mac|windows|linux">` is set before
 * the first paint (index.tsx) so CSS can follow the platform (the macOS traffic-light gap, the Windows window buttons).
 */
export type Platform = "mac" | "windows" | "linux";

interface NavLike {
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
}

/** Pure detection, testable with a fake navigator. Anything unknown counts as Linux (the macOS look stays macOS-only). */
export function detectPlatform(nav: NavLike | undefined = typeof navigator === "undefined" ? undefined : (navigator as NavLike)): Platform {
  const hint = `${nav?.userAgentData?.platform ?? ""} ${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`;
  if (/Mac|iPhone|iPad/i.test(hint)) return "mac";
  if (/Win/i.test(hint)) return "windows";
  return "linux";
}

/** The platform of this page; the `data-platform` attribute wins once it is set, so tests can pin one. */
export function currentPlatform(): Platform {
  const attr = typeof document === "undefined" ? undefined : document.documentElement.dataset.platform;
  return attr === "mac" || attr === "windows" || attr === "linux" ? attr : detectPlatform();
}

/** Writes `data-platform` on `<html>`; called once at boot. */
export function applyPlatformAttribute(doc: Document | undefined = typeof document === "undefined" ? undefined : document, platform: Platform = detectPlatform()): Platform {
  if (doc) doc.documentElement.dataset.platform = platform;
  return platform;
}
