# Dashboard and widgets

The Dashboard is a tab of cards that shows, at a glance, what your agents are doing, how much of your plan is left, the state of your repositories and servers, and a few starter prompts that fit your project. It is made for people who build mostly by prompting coding agents. Applies to version 1.14.0.

It is a lazy extra that starts switched on. It opens as the first tab when a workspace with repositories opens (unless Agent mode is on screen); the palette command Open dashboard brings it back at any time. Settings > Dashboard turns it off, stops it opening at start, switches the plan usage in the menu bar on or off, and resets the card layout. It looks the same in the Standard and the Glass style, in light and dark.

## The cards

Every card has a loading, an empty and an error state, and an empty card always says why it is empty. A card whose source is not set up is absent, not empty.

| Card | What it shows | Where it comes from | Shown when |
|---|---|---|---|
| Run pulse | Running, needs-you, ready-for-review and failed runs; tokens and cost of today's runs; Start run | The agent store (the same rows as the Agents list) | Always |
| Burn-down | The 5-hour and weekly plan limits as bars with their reset time, today's spend and a 14-day trend | The Usage view's data (run logs and the plan limits) | Always; the limits only when the Claude CLI is installed and signed in |
| Repo heartbeat | Per repository: branch, ahead/behind, uncommitted changes and the last commit; a click opens its first change (or the Commit panel) | The repository snapshots and the last commit message | Always |
| Stack tips | The detected stack (React, React Native, Expo, Next.js, Express, Node.js, Sass, iOS, Android) and three starter prompts | `package.json` dependency names and the `ios/` and `android/` folders of up to six repositories | Always |
| Dev servers | The servers the Run panel started, with ports and memory; stop, start again, open in the browser | The Run panel's state and commands | Always |
| CI & PRs | Your open pull requests with their checks and review state | The PR bridge (GitHub CLI) | The PR extra is on; without `gh` a calm empty state says how to install it |
| Sentry triage | The busiest unresolved issues nobody has taken in the last 24 hours, with IntelyFIX's one-click Fix | The Sentry integration | Sentry is set up |
| Team chat | Unread messages and mentions, the busiest channels first | Team chat | Team chat is connected |
| Morning brief | Runs, failures, requests and changed files of the night | The night queue's brief | The night queue extra is on |

A starter prompt only fills the New run dialog: nothing runs until you press Start run, and the role and the repositories stay your choice. The detection reads only the names of dependencies; scripts and values in `package.json` are never looked at or run, guarded files and files over 512 KB are skipped.

## Arranging the cards

Press Edit layout. Each card then shows a handle, a size switch and a hide button:

- **Move**: drag the card by its handle onto another card, or focus the handle and use the arrow keys (Home and End move it to the start or the end). Escape cancels a drag. Every move is announced to screen readers.
- **Size**: S, M or L. The grid has four columns on a wide window, two in the middle and one on a narrow one; a large card takes the whole row.
- **Hide**: the card moves to the Hidden cards list under the grid, where Show brings it back.

Reset layout (in the edit mode and in Settings > Dashboard) brings back the default order, sizes and visibility. The layout is stored in `settings.json` under `widgets` (`order`, `sizes`, `hidden`), next to `showAtStart` and `trayPlan`, with a copy in the browser storage of the window for the first paint.

## How often cards refresh

Cards read the stores the rest of the app already keeps current, so most of them need no polling at all. The ones that ask a backend refresh only while the Dashboard tab is on screen, the window is visible and Eco mode is not active:

| Card | Refresh |
|---|---|
| Burn-down | Every two minutes at most, the same cadence as the Usage tab (reading the plan limits starts the Claude CLI for a moment) |
| CI & PRs, Sentry triage | Every ten minutes, and on Refresh |
| Morning brief | Every fifteen minutes, and on Refresh |

"On screen" means the tab you are looking at: another tab in front, or Agent mode over the editor area, pauses these cards. A refresh that fell due meanwhile happens once when the Dashboard is back on screen. In Agent mode the palette's Open dashboard shows it in the middle of the Agent workspace.

The Refresh button in the header asks every card to reload at once.

## Plan usage in the menu bar

With Settings > Dashboard > Plan usage in the menu bar switched on (it is off by default), the menu-bar item shows the share of the 5-hour plan window used next to the counts: `! 2 / 3 · 41%`, or `41%` alone when nothing runs, and the menu gets a line with the same number. The value is read every five minutes (not in Eco mode), or taken from the Dashboard or the Usage tab when they read it anyway. Turning the Dashboard off removes the percentage from the menu bar. The menu-bar item itself is switched on in Settings > Resources and menu bar (Show the IDE in the menu bar), as before; its entries stay native menu items.

## Needs-You radar

The radar is a small window that stays on top of other windows and lists the runs waiting on you: permission requests, questions and plans. It opens from the menu-bar entry Needs you (n) and with the palette command Open Needs-You radar. Each request has the same card as the in-app Needs-You inbox (Approve once, the answers of a question, the plan approval) and uses the same commands; Open run brings the main window forward with that run selected in Agent mode. The menu-bar entry opens the radar even while the Dashboard is turned off, and Open run works then too.

The radar never counts as the app's window focus, so Eco mode and the focus-gated background work neither start nor stop because of it, and it closes together with the main window. It runs the same interface bundle with only the radar and the agent list loaded (no workspace view). It is built for macOS first and works the same on the other platforms. Its window permissions are a subset of the main window's: the defaults and window dragging, nothing else.

## Privacy

The Dashboard opens no new network connection and sends nothing anywhere. It shows what the app already knows locally. The CI & PRs and Sentry triage cards make the same requests the PR bridge and the Sentry integration already make, and only while those features are switched on and set up. The plan limits are read through the Claude CLI on your machine, as the Usage view does; for the menu bar only when you switch that on.

## For module authors

A module adds a card with `registerWidget` from `ui/src/platform/widgets.ts`: an `id`, a `title`, a `category`, an `order`, a `defaultSize` (and optionally the `sizes` it offers), a lazy `component`, an optional `when` (the card is absent while it is false) and an optional `refresh: { everyMs }`. The component receives `size` and `refreshTick`, a signal the dashboard bumps on the refresh policy and on Refresh. Pure layout helpers (`arrange`, `moveTo`, `moveBy`, `withSize`, `withHidden`, `normalizeLayout`) are exported for tests.
