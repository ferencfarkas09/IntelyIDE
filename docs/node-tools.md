# Node tools

Node tools help you understand and look after a Node.js backend: which HTTP routes it has, a way to try one against your own dev server, whether your `.env` files are in order and kept out of Git, and which dependencies are outdated or have known security problems. Applies to version 1.14.0.

They live in the same tab and the same extra as the [Web tools](web-tools.md): open it with the command palette (Open Web & Node tools, or one command per tool), and turn it off in Settings > Web & Node tools. A tool appears only where its files exist: Routes needs Express, Fastify, Koa, Hono, NestJS or Next.js in a `package.json`, `.env` needs an `.env*` file, Dependencies needs a `package.json`. Reading files follows the same safety rules as the Web tools (no symbolic links, size and count caps, invalid UTF-8 replaced). Every finding has an explanation and an **Ask agent to fix** button that only opens the New run dialog with a prefilled prompt.

## Route map

Lists the routes your backend declares, with the method, the path and `file:line` (click to open it in the editor), found by reading the code. Nothing is started.

| Framework | What is recognised |
|---|---|
| Express, Koa (`@koa/router`, `koa-router`), Hono | `app.get('/path', ...)`, `router.post(...)` and the other methods, `all` |
| Fastify | the same, and `fastify.route({ method, url })` |
| NestJS | `@Controller('prefix')` (or `{ path }`) with `@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Head`, `@Options`, `@All`; the path joins the prefix and the decorator's path |
| Next.js | `app/**/route.ts` (also under `src/`), with the methods it exports (`GET`, `POST`, ...), and `pages/api/**` (the methods it mentions, otherwise "any"); route groups `(x)` and slots `@x` are not part of the URL |

A file counts as a backend file only if it imports one of these frameworks, so `map.get('/key')` and an `axios.get('/api/x')` in a React file are not routes. Paths are shown as written in each file: a prefix given where a router is mounted (`app.use('/api', router)`), a global prefix, and a path built from a variable are not resolved. The list is labelled a heuristic.

## Try it

Sends one HTTP request to a dev server and shows the status, the time, the headers and the body (the first 256 KB; a binary body is not shown). Click **Try** on a route to fill in its method and path, add headers and a body if you need them, and press Send.

What it can reach is limited on purpose:

- **Only a dev server you started yourself.** The target is a port that a server started from the Scripts panel is listening on right now (the same port list that panel shows). With no such server, the tool says so and sends nothing. The backend checks this again for every request; the screen cannot widen it.
- **Only this computer.** The address is always `127.0.0.1` (then `::1` if nothing answers there), never a host name, so no name lookup happens and nothing leaves the machine. The request line carries a path only: a full address, `//host`, spaces, backslashes and control characters are refused.
- **Redirects are shown, not followed.** A `Location` pointing anywhere, including another site, is displayed and nothing is requested from it.
- **Capped.** At most 64 KB sent, 20 custom headers (`Host`, `Content-Length`, `Connection`, `Transfer-Encoding`, `Upgrade` and similar are set by the tool and cannot be overridden), 16 KB of response head, 256 KB of response body and 8 seconds for the whole exchange. It uses plain `HTTP/1.1` over a TCP socket from the standard library, with no TLS, proxy or extra dependency, and `Connection: close`.

What you type, including a token in a header, goes to your own dev server and is not saved or logged.

## .env files

Compares the variable **names** of your `.env.example` (or `.sample`, `.template`, `.dist`, `.defaults`) with your real `.env`, `.env.local` and `.env.<mode>` files in each folder that has them, and lists:

- names in the example that no real file has (the app may fail to start),
- names in a real file that the example lacks (a new teammate would not know about them),
- a folder with an example but no `.env` yet, or a `.env` with no example,
- real env files that no `.gitignore` rule seems to cover ("not git-ignored"), and real env files that Git already tracks ("tracked by git": the content is in the history, so treat its secrets as leaked).

**Values are never read into the app.** The parser keeps only the names; a value is dropped unread, so it cannot appear on the screen, in a log, in an error message or in a prompt. The prompts for the agent hold names only and tell it never to read, print or copy a value. The `.gitignore` check is an approximation of Git's rules (wildcards, `**`, negation and directory rules, from every `.gitignore` in the repository); the tracked-file check asks Git (`git ls-files`, with the same hardening as every other Git call of the IDE).

## Check dependencies

An opt-in button that runs `npm outdated --json` and `npm audit --json` in a folder with a `package.json` and a `package-lock.json`, and lists:

- outdated packages with the current and the latest version, sorted by how far the jump is (major, minor, patch), and whether they are dev dependencies;
- known vulnerabilities with the severity, whether the package is a direct dependency and whether the fix is a normal update or a major update.

**It uses the network.** npm sends the names and versions of your dependencies to the npm registry (and to the registry in your `.npmrc`, if you set one). So nothing runs until you press the button and confirm in a dialog that says so. The commands are fixed (nothing from the screen becomes part of a command line), run in a process group of their own with a 90 second limit and a 4 MB output cap, and are refused when processes are not allowed (read-only safety mode without "Allow processes"). Nothing is installed and no file is changed. Only npm projects (with a `package-lock.json`) are checked; pnpm, Yarn and Bun projects get a note. The registry is not trusted: names, versions and titles are cut down to short printable text, and registry text is never put into a prompt.

**Ask agent to upgrade safely** opens the New run dialog with the list and a plan: patch and minor updates first, run the tests after each step, one major update at a time with its release notes, no `npm audit fix --force`, no hand-edited lock file.

## Privacy

The route map and the `.env` comparison run on your computer and send nothing. Try it sends one request to your own dev server on this computer. Check dependencies is the only part that uses the internet, only after you confirm, and it contacts the npm registry through npm, which is your own installation. Nothing is sent to IntelyHome or anyone else.

## Limits

- Routes mounted with a prefix, generated routes and routes built from variables are not found.
- The `.gitignore` check does not read global ignore files or `.git/info/exclude`.
- Only npm is supported by Check dependencies.
