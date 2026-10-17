# IntelyHome website (intelyhome.com)

Static site for IntelyHome and its two products, IntelyIDE and IntelyOpti. Plain HTML, CSS and a little vanilla JS, produced by a
dependency-free Node script (Node 20+). No server and no database of its own; Google Analytics loads only after the visitor
accepts, and the one other external request is the IntelyOpti e-mail form to the API. Fonts are self-hosted (Inter, JetBrains Mono, SIL OFL 1.1).

English lives at `/`, Hungarian at `/hu/`. Pages: `/` (company home), `/intelyide/`, `/intelyopti/`, `/download/` (IntelyIDE),
`/privacy/`, `/terms/`, `404.html`. Old `/#install`-style IntelyIDE anchors on the home page are forwarded to `/intelyide/` by `site.js`.

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
scripts/import-shots.mjs / import-opti-shots.mjs            one-off screenshot importers (macOS sips)
data/intelyopti-release.json                                IntelyOpti version/date/size/sha256 (optional, null fields are hidden)
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
| `assets` | Older shape: an array of `name`, `url`, `arch` (`x64`, `arm64` or `universal`), `size` (bytes), `sha256`. Current shape (written by `pnpm release:build`): an object keyed by platform, `mac` (one file, `arch: "universal"`), `windows` (`nsis`, `msi`) and `linux` (`appimage`, `deb`), each with the same fields. Both are read |
| `windowsSigned` | informational; the Windows installers are not code-signed yet |

With files for more than one platform the big button opens the release page without JavaScript, and `assets/site.js` points it at the
visitor's own file (macOS, Windows, or the Linux AppImage; unknown systems keep the release page). A line under it lists the other
platforms and files, followed by the Windows (SmartScreen) and Linux (`chmod +x`) notes. The analytics event `download_click` carries
`platform` (`mac`, `windows`, `linux`, or `other` for the release-page link).

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
Every shot is shown as light and dark in one picture: the dark capture is drawn over the light one and masked to the lower right of a
45 degree line through the middle, with a thin violet strip on the line (`.duo` in `style.css`, `picture()` in `src/lib.mjs`). It is a
gradient mask, so the line stays at 45 degrees for any aspect ratio, and the picture needs no script and no inline style. Both themes are
always shown, whatever theme the visitor chose; the light picture carries the alt text and the dark one is hidden from screen readers.
A slot that has only one theme is shown as a plain picture, so capture both (`--theme light` and `--theme dark`) for every name.
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
  persists in `localStorage` with a safe fallback. Screenshots do not follow it: they always show both themes.
- CSP is a `<meta>` tag with no `unsafe-inline`; the one inline script (theme restore) is allowed by hash.
- Download button text is dark on the gradient (contrast 5.3:1 or better at every stop).

## Products, trial and pricing

Everything about IntelyOpti that can change lives in `site.config.json`; the copy in `src/content/{en,hu}.mjs` uses
`{{trial}}`, `{{yearly}}`, `{{lifetime}}`, `{{freeMB}}`, `{{minMac}}` tokens that `build.mjs` fills (HU prices render as `19,99 USD`).

| Key | Meaning |
|---|---|
| `apiBase` | Trial/lead API, `https://api.intelyhome.com`. The form posts to `{apiBase}/api/lead` (contract: IntelyOpti `docs/API.md`). The CSP allows exactly this origin in `connect-src` |
| `checkout.enabled` | `false`: the Buy buttons read "Notify me when checkout opens" and lead to a waitlist form (`kind:"waitlist"`). `true`: they link to `checkout.yearlyUrl` / `lifetimeUrl` (both required, https; `check-site` fails if one is empty) |
| `intelyopti.trialDays`, `yearlyPrice`, `lifetimePrice`, `currency`, `freeCleanMB`, `minMacOS` | Numbers used in the copy, the pricing cards and the JSON-LD offers |
| `intelyopti.downloadUrl`, `releasesRepoUrl` | DMG link shown after the download form succeeds; the API response may override it, but only with a link on `githubUrl` |

`data/intelyopti-release.json` is written by the release script (`version`, `date`, `minMacOS`, `size` in bytes, `sha256`).
A `null` or missing field is not shown; the page also builds without the file.

The download form (`assets/lead.js`) collects e-mail, a consent checkbox and a hidden honeypot field `company`, posts with
`fetch`, disables the button while sending, reports errors in `aria-live` text (EN/HU) and then reveals the download button and
"open IntelyOpti and enter the same e-mail". Without JavaScript the form is hidden and a link to the GitHub releases is shown.

### Screenshots

```sh
node scripts/import-shots.mjs         # IntelyIDE: ../docs/screenshots/<name>-<light|dark>.png -> shots/<slot>-<theme>-720|1440 (+ webp when cwebp exists)
node scripts/import-opti-shots.mjs    # IntelyOpti: ../../IntelyOpti/site-assets/shots/opti-<name>-<light|dark>.png -> 720|1440|2400
node scripts/gen-placeholders.mjs     # neutral SVG only for slots that still have no real image
```

Opti names: `dashboard`, `health`, `turbo`, `tweaks`, `network`, `modes`, `advisor`, `cleanup` (2400x1600, transparent margin).
Sources are never upscaled; the pages accept any subset of widths. Every shot is a light and a dark `<source>` pair that follows
the site theme toggle and `prefers-color-scheme`. The IDE slots `team` and `team-memory` keep their older captures (no curated source exists).

### Review before launch

- `/privacy/` and `/terms/` (EN and HU) are short, factual drafts written generally. **A lawyer should review them**, in particular
  the controller identity, the legal bases, the retention wording, the refund/withdrawal paragraph, the licence restrictions,
  the liability clause and governing law (none is named). The deletion route (GitHub Discussions "Data request") is a process the
  owner must be ready to run.
- The API Worker must be deployed and `api.intelyhome.com` must resolve to it (CORS allows `https://intelyhome.com` and
  `https://www.intelyhome.com` only) before the forms work for visitors.
- `assets/img/og.png` is still the IntelyIDE card, shared by every page.
- The FAQ states Apple silicon Macs are not supported by IntelyOpti: confirm that is the intended wording.
