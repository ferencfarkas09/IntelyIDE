// One-line legal banner for files that travel without the repository (spec 5.2, 8.6): the sidecar bundles, the relay
// worker bundle and the remote-web build. The wording is fixed here so the Remote spec can prepend it BEFORE the relay
// bundle is hashed and signed. `licenses:check --release` fails while the source URL placeholder is still in use.
import { safeUrl } from "./texts.mjs";

export const SOURCE_PLACEHOLDER = "<repo URL, D7>";
export const BANNER_LICENSE = "GPL-3.0-or-later";
const COMPONENT_RE = /^[a-z][a-z0-9-]{0,30}$/;

/**
 * `/*! IntelyIDE <component> - GPL-3.0-or-later - source: <url> - third-party notices: THIRD_PARTY_LICENSES *\/`
 * @param {{ component: string, sourceUrl?: string }} o  sourceUrl: https only, a hostname, no userinfo, max 200 chars.
 */
export function legalBanner({ component, sourceUrl } = {}) {
  if (typeof component !== "string" || !COMPONENT_RE.test(component)) throw new TypeError("legalBanner: bad component name");
  let source = SOURCE_PLACEHOLDER;
  if (sourceUrl !== undefined) {
    source = safeUrl(sourceUrl);
    if (!source || /[\s*]/.test(source)) throw new TypeError("legalBanner: sourceUrl must be a plain https URL (hostname, no userinfo, max 200 chars)");
  }
  return `/*! IntelyIDE ${component} - ${BANNER_LICENSE} - source: ${source} - third-party notices: THIRD_PARTY_LICENSES */`;
}
