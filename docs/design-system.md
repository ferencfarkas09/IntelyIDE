# Design system

The design tokens, components and rules of the IntelyIDE interface. Target feel: a calm, dense, precise developer tool. Source: `ui/src/theme/` (tokens, fonts, global CSS, theme controller) and `ui/src/ui-kit/` (components). Live reference: run the UI dev server and open `/?view=kit` (side by side), `/?view=kit&theme=dark|light` (one theme), `&section=<id>` (one section: composite, buttons, selection, fields, badges, cards, feedback, overlays, tree, foundations), `&skin=standard|glass` (the style; the bar also has Style and Opaque switches).

Everything below is imported from `ui/src/ui-kit` (the barrel also pulls in the theme CSS). Call `initTheme()` once before the first render.

## Principles
1. One 4 px grid. Spacing, heights and radii come from tokens, never ad-hoc numbers.
2. Layered surfaces, hairline separation: app chrome (`surface-0`) -> panel (`surface-1`) -> raised (`surface-2`) -> overlay (`surface-3`). Separate with 1 px alpha borders or `inset box-shadow`, not heavy borders.
3. Restraint: neutral greys, one accent, semantic colours. Repo colours appear only in `RepoBadge` and small dots.
4. Hierarchy through type weight and the four text levels, not size changes. 13 px base, 11-12 px meta, tabular numbers for counts (`ui-tnum`).
5. Motion is short and functional: 120 ms for hover/press, 180 ms for check, switch, dialog, toast. One easing. Everything is disabled under `prefers-reduced-motion` (the spinner only slows down).
6. Colour is never the only signal: status letters, icons, arrows, `aria-*` text carry the meaning.
7. Every interactive element has a visible keyboard focus ring (2 px `--focus-color`, 1 px offset) and works from the keyboard.
8. Every base control comes from the kit. If something is missing, add it to the kit (small additive change), do not restyle a `<button>` in a feature.

## Tokens (`theme/tokens.css`)
Dark is the default. Light applies on any element with `data-theme="light"` (the controller sets it on `<html>`; the gallery also uses it on sub-trees). A bare `:root` follows `prefers-color-scheme` until the controller runs.

| Group | Tokens |
|---|---|
| Surfaces | `--surface-0..4`, `--surface-hover`, `--surface-active`, `--surface-selected`, `--surface-selected-inactive`, `--backdrop` (+ `--backdrop-blur`) |
| Borders | `--border-subtle` (6-7 % alpha), `--border`, `--border-strong` |
| Text | `--text-1` primary, `--text-2` secondary, `--text-3` tertiary/placeholder/meta, `--text-4` disabled only, `--text-on-accent` |
| Accent (brand violet) | `--accent`, `--accent-hover`, `--accent-active` (fills), `--accent-text` (text/icons on surfaces), `--accent-subtle`, `--accent-subtle-hover`, `--accent-border`, `--focus-color` |
| Semantic | `--ok`, `--warn`, `--danger`, `--info`, each with `-subtle` (13 % bg) and `-border`; `--danger-solid`, `--danger-solid-hover` for filled danger buttons |
| Repo palette | `--repo-1..8` (tuned per theme), `--repo-fg-mix` |
| Change status | `--status-modified` (accent), `-added` (ok), `-deleted` (dim + strike-through), `-renamed` (magenta, so it stays apart from the violet accent), `-untracked` (warn), `-conflicted` (danger) |
| Diff | `--diff-add-bg`, `--diff-add-strong`, `--diff-del-bg`, `--diff-del-strong` |
| Type | `--font-ui` (Inter Variable), `--font-mono` (JetBrains Mono Variable), `--text-xs/sm/base/md/lg/xl` = 11/12/13/14/16/20 px, `--weight-regular/medium/semibold` = 400/500/600 |
| Logo ink | `--brand-ink`, `--brand-sub`, `--brand-ide-a`, `--brand-ide-b`, `--brand-shadow` (read by `BrandMark`; the cursor and spark flip to dark ink in the light theme) |
| Spacing | `--space-1..12` = 4, 8, 12, 16, 20, 24, 32, 40, 48 px (`--space-half` 2 px for optical nudges) |
| Radii | `--radius-1..4` = 4 / 6 / 8 / 12 px, `--radius-full` |
| Sizes | `--control-sm/md/lg` = 24/28/32 px, `--row-compact` 22 px, `--row` 24 px, `--titlebar-h` 40 px, `--traffic-lights-w` 78 px |
| Elevation | `--shadow-sm`, `--shadow-md`, `--shadow-popover`, `--shadow-dialog` (popover and dialog include a 1 px ring), `--highlight-top` and `--highlight-accent` (inset top highlights on buttons) |
| Motion | `--dur-fast` 120 ms, `--dur` 180 ms, `--ease` |
| Layers | `--z-sticky` 10, `--z-chrome` 20, `--z-dialog` 1000, `--z-popover` 1100, `--z-toast` 1200, `--z-tooltip` 1300 |

Contrast (WCAG, worst case over the four surfaces): dark `text-1` 13.5, `text-2` 7.6, `text-3` 5.0 (4.7 on selected rows), accent-text 5.3, ok/warn/danger/info 5.5-7.6, white on accent 5.3 (hover 4.8), white on danger-solid 5.2; light `text-1` 15.4, `text-2` 7.8, `text-3` 5.3 (4.9 on selected rows), accent-text 6.0, ok/warn/danger/info 4.6-5.4, white on accent 6.0, white on danger-solid 5.3. `text-4` (2.6-2.8) is for disabled text and decorative line numbers only.

CSS custom properties that reference other variables (`--status-*`) are resolved where they are declared, so each theme block redeclares them. When adding such a token, add it to both blocks.

### Typography and fonts
Inter Variable and JetBrains Mono Variable are self-hosted from `@fontsource-variable/*`, latin + latin-ext only (`theme/fonts.css`), `font-display: swap`. Hungarian accented letters (`ő ű ö ü á é í ó ú`) render in both families (verified: all four `@font-face` subsets load). Body uses `font-feature-settings: "ss03", "calt"`, antialiased. Use `ui-tnum` for counts and sizes, `ui-mono` for hashes, paths-as-code and branch names.

### Utility classes
`ui-truncate`, `ui-tnum`, `ui-mono`, `ui-text-2/3/4`, `ui-sr-only`, `ui-selectable` (re-enables text selection; the app chrome is `user-select: none`), `ui-theme-scope` (themed sub-tree background), `ui-file-deleted` (dim + strike-through file name), `ui-path-hint` (dim path after a file name).

## Glass skin (`theme/glass.css`, `theme/skin.ts`)
A second look on its own axis: `data-skin="glass"` on `<html>`, independent of `data-theme` (light, dark) and `data-accent`, so every theme and accent combination works with both skins. The style is chosen in Settings > Appearance > Style (Standard or Glass) and stored in settings.json (`appearance.skin`, mirrored in `localStorage` for the first paint). `?skin=standard|glass` shows a skin for screenshots without storing it.

Default: Glass for new installs only. A profile with no `intely.*` key in `localStorage`, no other appearance choice and no workspace is judged new once, at boot, and the verdict (`glass` or `standard`) is written to settings.json; later boots never guess again. Installs from before Glass have no `skin` key and stay on Standard until the person picks Glass.

What Glass changes:
- Backdrop: a soft gradient on `<html>` (light: blue, lilac, peach; dark: deep indigo, violet, teal) over an opaque base colour, so the page background stays opaque for checks such as `assertTheme` in `scripts/e2e/shots-lib.js`. `body`, `.shell` and `.ui-theme-scope` turn transparent.
- Panes float as rounded sheets (`--radius-card` 18 px, hairline `--glass-border`, inset `--glass-highlight`, soft `--card-shadow`): the tool window, the centre, the dock and the Agent mode panes. Each pane paints one tint (`--glass-panel`); `--surface-1` is transparent in Glass, so nested panels never stack their tints. The rail, title bar and status bar sit on the gradient with the light `--surface-0` tint.
- `--surface-2` (raised: cards, fields, pills), `--surface-3` (overlays) and `--surface-4` (controls) are translucent tints. Popovers, menus, dialogs, toasts and tooltips are frosted (`backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate))`); `class="glass-frost"` gives custom floating UI the same, `class="glass-panel"` the pane tint.
- Editors, the diff and the terminal stay solid: inside `.cm-editor`, `.diff-view`, `.term-host` and `.xterm` the surfaces resolve to the opaque `--pane-1..4`. Code that paints from tokens (xterm, the lane graph canvas) reads `--pane-*`, never a translucent surface, and repaints on `appearanceLook()` (theme + skin + transparency), not only on `resolvedTheme()`.
- Shape (also when opaque): capsule pills and badges (`--radius-full`), `--radius-3` 10 px, `--radius-4` 16 px, larger rail buttons and tree row highlights. Selected rows in a focused tree, the palette and the Settings list get a solid accent fill with the on-accent ink for every text level (any mix with the fill would drop below 4.5:1); a checked box on such a row turns into an on-accent box with an accent tick.
- Seams: sticky headers and footers (`.ui-grid__header`, the matrix and table headers of the checks, l10n, MCP, release and versions panels) get the frosted `--glass-sticky`; tree row actions no longer sit on an opaque patch, the trailing pills fade out instead.

Fallbacks, all opaque (Standard surfaces, no gradient, no blur; the Glass shape stays): the Settings switch "Reduce transparency" and the OS settings `prefers-reduced-transparency: reduce`, `prefers-contrast: more` and `forced-colors: active` (both set `data-transparency="reduced"`, see `skin.ts`), and any engine without `backdrop-filter` (`@supports`). Rules that make something translucent must sit inside the `@supports` block and carry `:not([data-transparency="reduced"])`; `glass.test.ts` checks this.

Contrast: the tints and gradient stops live in `theme/glassTokens.ts` as data (and `glass.test.ts` checks that `glass.css` uses exactly those numbers). `accents.ts` composites every glass surface over every gradient stop (and the bare stops) and adds them to `SURFACES`, so every generated accent is solved and tested against them. Worst case on Glass: light `text-1` 14.2, `text-2` 7.2, `text-3` 4.9, accent-text 5.5, ok/warn/danger/info 4.5-4.9; dark `text-1` 12.2, `text-2` 6.9, `text-3` 4.6, accent-text 5.3, ok/warn/danger/info 5.0-6.8; `text-4` 2.4-2.6 (never weaker than on the standard surfaces). When you change a tint, change `glassTokens.ts` with it and run `vitest run src/theme`.

Native window vibrancy (Tauri `windowEffects`) is not used: the effect is CSS only and works the same in the macOS, Windows and Linux webviews.

## Components
All props are typed; see the source for the full list.

| Component | Use it for | Notes |
|---|---|---|
| `Button` | Actions with a text label | `variant` primary / secondary / ghost / danger, `size` sm / md / lg, `loading` (keeps width and focus), `icon`, `iconRight`. One primary per surface. |
| `IconButton` | Toolbar and row actions | `label` required (aria-label and tooltip), `shortcut` shows Kbd chips, `pressed` for toggles, `disabled` uses `aria-disabled` so the tooltip can explain why ("Graph (soon)"). |
| `SplitButton` | Primary action + alternatives | "Commit" with "Commit and Push..." in the menu. |
| `Checkbox` | Selection | `checked: boolean \| "mixed"`; clicking mixed selects all. Derive the parent state with `deriveCheckState(checked, total)`, never store it. Native input underneath (Space works); click does not bubble to the row. |
| `Switch` | Immediate on/off settings | `role="switch"`. Use a Checkbox for form-like choices. |
| `SegmentedControl` | 2-4 mutually exclusive views | Radio-group semantics, arrow keys, sliding thumb. A disabled option can carry a tooltip. |
| `Badge`, `Pill`, `StatusDot`, `StatusLetter` | Counts and tags (Badge), compound repo status (Pill, button when `onClick`), state (StatusDot with `label`), change kind (StatusLetter) | Tones neutral / accent / ok / warn / danger / info. |
| `RepoBadge`, `BranchPill`, `AheadBehind` | Repo identity, branch, ahead/behind | `RepoBadge` takes any `#rrggbb`; `AheadBehind` renders nothing when in sync. `BranchPill` keeps the end of a long name (middle ellipsis, 52 px floor) and its tooltip carries the full name plus `upstream`; in repo rows the repo name shortens before the pill does. `REPO_PALETTE` and `pickRepoColor` for pickers. |
| `Kbd` | Shortcuts | `keys={["⌘","⇧","K"]}`; Tooltip and Menu render it for you. |
| `Tooltip` | Names and shortcuts of icon-only controls | One child element; 450 ms delay, none right after another closed; keyboard focus shows it; Esc dismisses. |
| `Dialog` | Modal tasks | Focus trap, Esc, backdrop click, restores focus, `role="alertdialog"` for confirmations, `data-autofocus` picks the first focus. Header close button, optional footer. |
| `Popover`, `Menu` | Anchored panels, action menus | Esc and outside press close and return focus to the trigger. Menu: arrows, Home/End, type-ahead, checkable and danger items, shortcut chips. Overlays mount inside the nearest `[data-theme]` element. |
| `Toaster` + `toast` | Transient results | `toast.success/error/warn/info/show`, pause on hover/focus, errors use `role="alert"`. Mount one `<Toaster />`. |
| `Splitter` | Resizable panes | Pointer, arrow keys (Shift = 64 px), Home/End, double-click or Enter resets. `storageKey` persists the size (try/catch). `primary` picks which pane has the pixel size. |
| `Card` | Grouped content on dashboards and summaries | `title` (names the region), `subtitle`, `actions`, `padding` none / sm / md. Rounded `--radius-card`, translucent in Glass. |
| `KpiTile` | One number on a dashboard | `label`, `value` (formatted), `unit`, `delta` (`{ value, direction: up/down/flat, upIsGood }`: green when good, red when bad, spoken as "up 12%"), `hint`, `sparkline` slot. |
| `Sparkline` | A small trend | Inline SVG, no chart library: `values`, `tone`, `area` (soft fill), `width`/`height` (scales to its box, the stroke stays crisp). `role="img"`, named "Trend: first to last" unless `title` is given. `sparkGeometry()` is the pure maths. |
| `Tabs` | Switching panels in place | WAI-ARIA tabs with one tab stop, arrows/Home/End select, disabled tabs skipped; panels are yours (`panelId` sets `aria-controls`). Underline in Standard, capsule segments in Glass. |
| `Skeleton`, `EmptyState`, `Spinner`, `ProgressBar` | Loading, empty, error, progress | EmptyState: an icon and one clear sentence, `tone="danger"` for errors. |
| `Input`, `TextArea` | Text entry | Focus ring on the whole field, `invalid`, `leading`/`trailing` slots. TextArea grows between `minRows` and `maxRows`. |
| `ScrollArea` | Scroll containers | Thin scrollbars, edge hairline + shadow when content continues; `ref` gives the viewport (virtualisers). |
| `Tree`, `TreeRow` | Trees and lists | 24 px rows (`compact` = 22 px), indent guides, `expanded` (undefined = leaf), `selected`, `cursor`, `tabbable`, `leading` / `trailing` / `actions` (hover and focus) slots, `aria-level/expanded/selected`. Keyboard handling stays with the feature. Selected rows tint with the accent only while the tree has focus. |
| `TitleBar` | Overlay title bar | `data-tauri-drag-region` on the bar, spacer and slots; 78 px traffic-light spacer; `left`, `center`, `right`. Interactive children stay clickable. |
| `VisuallyHidden`, `LiveRegion`, `Announcer`, `announce()` | Screen-reader output | Mount `<Announcer />` once, call `announce("3 repos committed")`. |
| `BrandMark`, `BrandButton` | The IntelyIDE logo | See Brand below. |
| `Icon` | Every icon | lucide-solid at 12/14/16 px with consistent stroke; decorative unless `label` is set. Add new icons to `ui-kit/icons.ts`. |
| Skin | `applySkin(skin, reduceTransparency)`, `activeSkin()`, `transparencyReduced()`, `appearanceLook()` | See Glass skin above. Settings > Appearance calls `applySkin`; read `appearanceLook()` in effects that paint from tokens. |
| Theme controller | `initTheme()`, `themePreference()`, `resolvedTheme()`, `setThemePreference("system" \| "dark" \| "light")` | Persisted in `localStorage` (`intely.theme`, try/catch), follows OS changes in system mode, sets `data-theme` on `<html>`. |

## Brand
The logo is B2 (three code lines with an AI cursor and spark), its sources are in `assets/brand/source/`. Everything below is generated, never hand-edited: `node scripts/brand/build-brand.mjs` (dev dependencies `opentype.js`, `@resvg/resvg-js`, `@fontsource/sora`; deterministic; it also calls `pnpm exec tauri icon`).

| Output | Where | Notes |
|---|---|---|
| Mark | `assets/brand/mark-{dark,light}.svg` | Transparent ground. Dark ink (white cursor and spark) for dark surfaces, `#1A0A2E` ink for light ones. |
| Small mark | `mark-small-{dark,light}.svg` | For 16 and 32 px: heavier bars, taller cursor, no spark. |
| App icon | `app-icon.svg` (macOS grid: 824 px tile inside 1024, 22.5 % radius, ground `#3D1458` to `#160823`), `app-icon-flat.svg`, `app-icon-flat-small.svg` | PNGs 1024, 512, 256, 128 from the grid icon, 64 flat, 32 and 16 flat with the small mark: `assets/brand/png/`. |
| Lockups | `lockup-horizontal-*.svg`, `lockup-stacked-*.svg` | Wordmark and subtitle are Sora Bold / Medium converted to outlines, so no font is needed at runtime. |
| Tauri icons | `src-tauri/icons/` (`icon.icns`, `icon.ico`, `icon.png`, `32x32.png`, `128x128.png`, `128x128@2x.png`) | `tauri.conf.json` bundle.icon lists them. In `tauri dev` on macOS Tauri sets the Dock icon from the icns. |
| Web | `ui/public/brand/` (`favicon.svg` = flat tile with the small mark, `favicon.png`, mark and lockup copies) | Linked from `ui/index.html`. |
| Layout data | `ui/src/ui-kit/brandGeometry.ts` (generated) | Mark data and the outlined wordmark paths that `BrandMark` renders. |

`BrandMark` props: `variant` (`mark`, `small`, `lockup`, `stacked`; default `small` up to 32 px, else `mark`), `size` (height in px), `theme` (pin `dark` or `light` instead of following the app), `tile` (on the dark app-icon tile), `shadow` (default from 48 px up), `label` (decorative when omitted). Gradient ids are unique per instance, ink comes from the `--brand-*` tokens. Use `small` at 16-32 px.

Where it appears: a 20 px `BrandButton` left of the Agent / Editor switch in the title bar (opens the About dialog: stacked lockup, version, build, runtime), the favicon, the first-run diff empty state (`EmptyState visual`), and the splash tile (`shell/Splash.tsx`, shown until the first workspace load, fades out in 180 ms; static under `prefers-reduced-motion`). The logo gradient is used in three places only: the wordmark, the primary button hover glow and the active rail indicator.

The accent family is derived from the logo violet (`#7C4DFF` to `#9B7BFF`) and replaces the former blue, keeping the contrast numbers above. Because modified files are shown in the accent colour, `--status-renamed` moved to magenta.

## Polish rules (1b)
- **Syntax colours** are tokens too: `--syn-keyword|function|string|number|type|property|tag|attr|meta`, defined for dark and light (5.2:1 or more on `--surface-1`, 4.6:1 or more on the added-line tint). The diff's CodeMirror highlight style uses only these; the grammar is loaded (lazy chunk per language) before the editor is created, so deleted lines are highlighted as well.
- **Names that may not fit** (branches) use `MiddleEllipsis`: the head shrinks with an ellipsis, the last word (`-design`) stays. The full name and the upstream go in a tooltip.
- **Row actions replace the row's counters** on hover/focus instead of covering them (`data-has-actions` on `TreeRow`), so nothing is cut mid-letter and nothing moves.
- **Overlay placement**: menus and popovers name their preferred side (`SplitButton menuPlacement="top-end"` in the Commit panel) and flip/clamp on collision; toasts stack above the results sheet (`--toast-lift`) and never cover its buttons.
- **Sensitive files** (tracked, secret-like name) get a warn-coloured lock badge in the row, their diff stays hidden until Reveal, and committing them asks once more (`SensitiveConfirm`).

## Do
- Put one `Tooltip`/`label` on every icon-only control and show its shortcut.
- Use `loading` instead of swapping button labels or disabling and hoping.
- Use `aria-disabled` (via `disabled` on IconButton / SegmentedControl options) when a tooltip should explain why something is unavailable.
- Show an `EmptyState` with an icon and one sentence for empty and error views; `Skeleton` while loading.
- Use `StatusLetter` plus the name for change kinds; add `ui-file-deleted` for deleted files.
- Keep counts in `Badge numeric` or `ui-tnum`.
- Keep overlays inside the app theme: render `Dialog`, `Menu`, `Popover`, `Tooltip` from the kit so they inherit tokens.

## Do not
- Do not hard-code colours, radii, shadows or durations; use tokens. No `#fff` text on custom fills (use `--text-on-accent`).
- Do not use `--text-4` for readable text, or `--accent` as text colour (use `--accent-text`).
- Do not add borders heavier than 1 px or use repo colours for anything besides `RepoBadge` and dots.
- Do not animate layout properties, exceed 180 ms, or add a second easing. No animation libraries.
- Do not style a raw `<button>`, `<input>` or checkbox in a feature; extend the kit.
- Do not store tri-state in state; derive it from the leaf selections.
- Do not rely on colour alone to convey status.

## Tauri CSP needs
`default-src 'self'; font-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'`. Fonts are bundled as hashed `.woff2` assets (`font-src 'self'`, no remote fonts). Inline styles are required: Solid sets `style` attributes (positions of popovers and splitter panes, `--depth`, repo colours). No `eval`, no remote scripts, no `blob:` or `unsafe-inline` for scripts.
