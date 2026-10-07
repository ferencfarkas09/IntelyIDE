# Publishing the website

The site is a static folder (`dist/`). It is deployed to Cloudflare as a Worker with static assets: `wrangler.jsonc`
names the Worker `intelyide`, so the address is `https://intelyide.ferenc-farkas.workers.dev` (the `siteUrl` in
`site.config.json`). The site collects nothing and publishes no contact details: the footer links to the repository's
Issues and Discussions.

## Deploy

```sh
cd site
npm run deploy        # build, production check, then wrangler deploy
```

From the repository root the same is `pnpm run site:deploy`. Do not type `pnpm deploy`: that is a different, built-in
pnpm command.

`npm run deploy:dry` runs the same build and check and ends with `wrangler deploy --dry-run`, which uploads nothing.

The scripts run wrangler at the version the Remote relay pins (`remote-relay/package.json`), through `npx`, so nothing is
added to the repository's dependencies.

## First time

1. `npm run login` opens a browser for Cloudflare's OAuth login. Alternatively export `CLOUDFLARE_API_TOKEN` (the "Edit
   Cloudflare Workers" template is enough) and, if the token sees several accounts, `CLOUDFLARE_ACCOUNT_ID`.
   Never write a token or an account id into a file of this repository.
2. If a Worker called `intelyide` already exists (for example one made in the dashboard), `wrangler deploy` replaces its
   content with this site; wrangler asks first when the dashboard version differs.

## Before a release

`data/release.json` is the only source of the download facts: version, date, `minMacOS`, asset URLs, sizes and SHA-256
values. Update it from the finished disk image, then run `npm run deploy`. The production check refuses a placeholder.

## Custom domain (optional)

Add the domain to the Worker in the Cloudflare dashboard (Workers, `intelyide`, Settings, Domains and Routes), set
`siteUrl` in `site.config.json` to `https://your-domain` (`basePath` stays empty), then deploy again.

## Smoke test

Open `/`, `/hu/`, `/download/` and a missing URL (the 404 page). Open the download button and compare the checksum of the
file with the one on the page.

## Another host

`dist/` is plain static files with relative asset paths, so any static host works. For GitHub Pages under
`https://<user>.github.io/<repo>/` build with `BASE_PATH=/<repo> SITE_URL=https://<user>.github.io` (these variables
override `site.config.json`) and publish the contents of `dist/`; `dist/.nojekyll` is already included.
