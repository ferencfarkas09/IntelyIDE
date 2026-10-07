// The `showcase` scenario: a believable, fully fictional demo workspace ("Acme Shop") used for the product screenshots
// on the website (site/scripts/capture-shots.mjs). Nothing here is a real project, person or host.

/** True when the page was opened with `?scenario=showcase` (or `showcase-welcome`: no workspace open, the Welcome screen). */
export const isShowcase = (): boolean => new URLSearchParams(globalThis.location?.search).get("scenario")?.startsWith("showcase") === true;

export const SHOWCASE_WORKSPACE = "Acme Shop";
export const SHOWCASE_ROOT = "/Users/demo/code";
export const SHOWCASE_AUTHOR = "Jordan Lee";
/** The repository the mock agent runs work in (the id stays `admin`, the name is `storefront-admin`). */
export const SHOWCASE_ADMIN_PATH = `${SHOWCASE_ROOT}/storefront-admin`;
