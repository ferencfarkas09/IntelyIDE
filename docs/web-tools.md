# Web tools

Web tools help you look after the CSS, SCSS and React code of a project that you mostly build by prompting a coding agent: where your colours and spacings live, which styles nobody uses, and which React components have problems a screen reader or a keyboard user would hit. Applies to version 1.14.0.

It is a lazy extra that starts switched on. Open it with the command palette (Open Web & Node tools, or one command per tool); Settings > Web & Node tools turns it off. Each tool appears only in a repository that has the files it works on: the token and unused-style tools need a `.css`, `.scss`, `.sass` or `.less` file, the React checks need React in a `package.json` or a `.jsx` / `.tsx` file, and the bundle report needs an existing build output. The [Node tools](node-tools.md) (routes, Try it, `.env`, dependencies) live in the same tab.

Every tool only reads. Nothing is changed, deleted or sent anywhere. Every finding has a plain-language explanation, a confidence (sure, likely or unsure) where the tool cannot be certain, and an **Ask agent to fix** button. That button opens the New run dialog with a precise prompt for this repository; nothing runs until you press Start run. The prompts tell the agent to verify each finding first, to make the smallest change, to show the diff, and not to commit or push.

## How the files are read

A repository is treated as hostile input. The tools skip `node_modules`, `dist`, `build`, `out`, `Pods`, `vendor`, `target`, hidden folders and every symbolic link, stop after 6,000 folders or 40,000 files, read a file only if it is at most 1.5 MB (4 MB for a stylesheet) and 160 MB in total, and replace invalid UTF-8 instead of failing. A file that is too large is named, not read. The scanning is done with linear loops (no regular-expression engine), so a crafted or minified file costs time in proportion to its size. A single folder is read only up to 20,000 entries, and what a scan keeps in memory from the stylesheets is capped (declarations that nothing compares, such as `display: flex`, are dropped at once). A file is opened through directory handles that do not follow links, so a link that appears while a scan runs cannot lead it outside the repository.

## Design tokens

Lists the CSS custom properties (`--brand`), SCSS variables and maps (`$brand`) and Less variables (`@brand`) that your stylesheets define, with:

- **Usage counts.** A token is used when `var(--brand)` or `$brand` appears in a stylesheet, a script (`.ts`, `.tsx`, `.js`, `.jsx`) or a page (`.html`, `.vue`, `.svelte`). A name that only appears as text (`getPropertyValue('--brand')`) counts as mentioned, not unused.
- **Unused tokens**, with a confidence. Names can be put together at run time (`` `var(--${name})` ``); if the scan sees that anywhere, every "unused" is marked likely instead of sure. A repository with an `@forward` (a shared SCSS library) also lowers the confidence of its variables.
- **Values that could use a token**: a hard-coded colour or a spacing in a stylesheet that equals an existing token value (`#FF0000` and `#f00` compare equal; `16px` in `padding`, `margin`, `gap`, `width` and similar properties). The suggestion is written as `var(--brand)` or `$brand`.
- **Duplicate colours**: two token names holding the same colour, and colours typed by hand three times or more where no token holds them.
- **Colour swatches** of the tokens whose value is a colour. A swatch is painted only from a hex colour or a plain `rgb()` / `hsl()` value; anything else is shown as text and never put into a style.

Tailwind v4 theme variables (`@theme { --color-brand: ... }`) are not reported as unused when a utility class uses them (`bg-brand`, `font-display`): they carry a "used as a class" mark instead.

Token values are shown only when they are plain colours or lengths, and only those are quoted in prompts.

## Unused styles

Lists class selectors that are defined in a stylesheet and that nothing seems to use, per file, with a confidence. It never deletes anything. Classes are looked for in the strings of scripts and markup (`className="a b"`, `class="..."`, `classList.add('x')`, `clsx('a', cond && 'b')`), and in CSS-module imports (`styles.title`, `styles['title']`, named imports). SCSS nesting is resolved, so `.card { &__title {} }` defines `card__title`. Results:

- **unused**, with a confidence. "Sure" is said only when the project composes no class names at run time at all. A class helper call (`clsx`, `cn`, `classnames`, `cx`, `twMerge`, `cva`), a template literal with `${}` in a string, `classList=` / `classList.toggle`, or a computed `styles[name]` anywhere makes every verdict "unsure", because such calls take class names as bare object keys (`clsx('tab', { active: on })`) and strings put together at run time. The words inside a helper call count as uses;
- **dynamic, unsure**: a template literal or a string joined at run time starts like the class name (`` `btn-${kind}` `` makes every `btn-...` class dynamic).

Classes used by third-party code, by a template this scan cannot read, or by a name assembled in an unusual way can be reported by mistake. Check before you remove one; the agent prompt says the same. Classes inside Vue and Svelte `<style>` blocks are not checked. Class names written with escapes in the stylesheet (`.md\:flex`, `.w-1\/2`) are compared by their unescaped name with the whole string used in the markup.

## React checks

Heuristic checks on `.jsx` and `.tsx` files (and `.js` files that mention React); test, story and `__tests__` files are skipped. The files are read, not compiled or run, so every result is labelled as a heuristic and can be a false alarm:

| Check | What it looks for |
|---|---|
| Images without alt text | `<img>` with no `alt` (`alt=""` is accepted as decorative) |
| Buttons and links with no readable text | `<button>` or `<a>` with no text, no expression, no `aria-label`, `aria-labelledby` or `title`, containing only icons or nothing |
| Inputs without a label | `<input>`, `<textarea>`, `<select>` with no `aria-label`, no wrapping `<label>` and no `id` that a `htmlFor` could point to |
| Clicks on elements the keyboard cannot reach | `onClick` on a `div`, `span`, `li` and similar without `role`, `tabIndex` or a key handler |
| Lists without a key | `.map(x => <Tag />)` where the returned element has no `key` (and a returned `<>` fragment) |
| Very large components | a function component longer than N lines (default 200, you can change it) |
| Components with many props | a component that destructures or types more than N props (default 10) |

The tag scanner is tolerant, not exact: JSX text that contains an apostrophe or `//` can hide the rest of its line, a component built in an unusual way may not be recognised, and a spread (`{...props}`) makes the checks that depend on attributes stay quiet.

## Bundle size

Reads an existing build output (`dist`, `build`, `out`, `.next/static`, `.output/public`, `web-build`, `www`, also inside `apps/*`, `packages/*` and `client`, `web`, `frontend`) and shows the total, a total by kind (JS, CSS, images, fonts), the 10 biggest files with bars, the age of the newest file, and source maps apart (visitors do not download them). The compressed size is an estimate from a typical ratio per file type (the standard library has no compressor), not a measurement; the panel says so. It never runs a build. If your source is newer than the build, build again to see current sizes.

## Element styles in the preview

The preview's click-to-source also shows the clicked element's key computed styles, finds the CSS rule that styles it and can ask an agent to restyle it; see [Preview and inspect](preview-inspect.md).

## Privacy

Everything in this page runs on your computer, reads files of your repositories and sends nothing over the network. The only text that leaves the tool is a prompt you open with an Ask agent button: it holds paths, class and token names, line numbers and (for tokens) plain colour or length values, flattened to single lines of printable text, and it goes nowhere until you start the run.

## Limits

- The scans are static. Styles written in JavaScript (styled-components, CSS-in-JS), Tailwind utility classes and class names that come from data are outside what they can see.
- At most 3,000 unused classes, 300 hard-coded values, 1,000 React findings and 600 routes are listed; the result says when it was cut.
- Indented Sass (`.sass`) is read in a simplified way.
