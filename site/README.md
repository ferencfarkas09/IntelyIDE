# IntelyIDE website

Static download site for IntelyIDE. Plain HTML, CSS and a little vanilla JS, produced by a
dependency-free Node script (Node 20+). No server, no database, no cookies, no analytics, no
external requests. Fonts are self-hosted (Inter, JetBrains Mono, SIL OFL 1.1).

English lives at `/`, Hungarian at `/hu/`. Pages: home, `/download/`, `404.html`.

## Layout

```
site.config.json        site URL, base path, GitHub links (the single edit point)
wrangler.jsonc          the Cloudflare Worker that serves dist/ (see DEPLOY.md: npm run deploy)
data/release.json       every download fact: version, status, assets, checksums, signed flag
src/content/en.mjs      all English copy      (hu.mjs has the same shape)
src/pages.mjs           page templates        src/lib.mjs: release data, <picture>, icons
src/static/             copied verbatim into dist/ (CSS, JS, fonts, images, favicons)
scripts/build.mjs       builds dist/          scripts/check-site.mjs: release gate
scripts/gen-placeholders.mjs / shots.mjs / make-images.sh   screenshot slots and variants
```

## Local preview

```sh
cd site
BASE_PATH= SITE_URL=http://localhost:4173 node scripts/build.mjs
node scripts/serve.mjs          # http://localhost:4173
```

## Editing release.json

`data/release.json` is the only place download facts live. The build writes them into the HTML,
so the visitor's browser never calls the GitHub API and the download link works without JavaScript.

| Field | Meaning |
|---|---|
| `version`, `status` | `status` is `alpha`, `beta` or `stable` (stable prints no label) |
| `date`, `minMacOS`, `notesUrl` | shown under the button and on `/download/` |
| `signed` | `false` shows the Gatekeeper "Open Anyway" note; `true` replaces it with a signed-and-notarized line |
| `appleSiliconPlanned` | only used when the sole asset is `x64`; selects the "planned" wording |
| `primaryArch` | optional; which asset is the big button when there are several (a `universal` asset always wins) |
| `assets[]` | `name`, `url`, `arch` (`x64`, `arm64` or `universal`), `size` (bytes), `sha256` |

Get a checksum with `shasum -a 256 IntelyIDE_0.1.0_x64.dmg`. With both `x64` and `arm64` assets the
button shows one and links the other; Chromium browsers that reveal the CPU swap them automatically.
With one asset the page says plainly which architecture it is.

## Screenshots

The real screenshots in `src/static/assets/img/shots/` come from the app's browser mock with a fictional
"Acme Shop" workspace (scenario `showcase`), captured by headless Chrome over CDP:

```sh
node site/scripts/capture-shots.mjs [names] [--theme light|dark] [--quick]   # needs the UI dev server on :1420
sh site/scripts/make-images.sh                                              # 1440/720 PNG + WebP (+ AVIF if avifenc is installed)
```

Files are `<name>-<light|dark>-<2880|1440|720>.<png|webp|avif>`; the build picks them up automatically.
A slot without real files falls back to a generated SVG placeholder (`node scripts/gen-placeholders.mjs`).
Names: `hero`, `changes-tree`, `push-dialog`, `agent-approval`, `rewind`, `workspaces-welcome`, `preview`,
`remote`, `mongo-studio`, `providers`, `api-contract`, `api-explorer`. All shots are English.
The About dialog shot is not used: it still shows "your Happy tools" copy, a dev version and the old lockup subline.

`assets/img/og.png` (1200x630, Open Graph and Twitter) and `social-preview.png` (1280x640, for the GitHub
repository social preview setting) are branded cards, not screenshots.

Provider marks in `assets/img/providers/` are Simple Icons (CC0). They are third-party trademarks shown only
to name tools the app can connect; the footer says so. Goose and the custom ACP agent use a text badge.

## Build, check, publish

```sh
cd site
node scripts/build.mjs
node scripts/check-site.mjs --prod
```

`check-site.mjs` fails on any external URL other than the project's GitHub links and the site itself,
on an `<img>` without `alt`, and (`--prod`) on any `REPLACE_ME` or `REPO-NAME` left in `dist/`. It only
warns about any `TODO-CONFIRM` marker left in a page (none is in the sources now).

See [DEPLOY.md](DEPLOY.md) for GitHub Pages.

## Design notes

- The logo files in `assets/brand/` include a lockup with an old "INTELYSWITCH IDE" subline. The site uses
  the mark plus a live-text wordmark instead.
- Theme: tokens on `:root`, redefined under `prefers-color-scheme: dark` and `[data-theme]`; the toggle
  persists in `localStorage` with a safe fallback. Dark `<source>` elements follow the toggle (`site.js`).
- CSP is a `<meta>` tag with no `unsafe-inline`; the one inline script (theme restore) is allowed by hash.
- Download button text is dark on the gradient (contrast 5.3:1 or better at every stop).
