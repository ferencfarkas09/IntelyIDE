# Localization checker and release assistant

This guide describes two optional extras that check translation catalogs and draft release notes. Applies to version 1.1.0.

Two lazy extras, each behind a Settings toggle (Settings > Localization, Settings > Release assistant). The toggle is mirrored in `localStorage` (`intely.extra.l10n`, `intely.extra.release`) so `register()` reads it synchronously; the durable copy is `settings.json` namespace `extras`. While off, only the Settings section exists: no tab, no badge, no watcher, no command.

Logic lives in `crates/l10n` (Tauri-free, read-only git, fixture tests). Glue: `src-tauri/src/modules/l10n.rs` (`l10n_analyze`, `l10n_apply`, `l10n_draft`, `l10n_release_plan`, `l10n_release_apply`). UI: `ui/src/modules/l10n`, `ui/src/modules/release`, plus the small `platform/changeBadges.ts` slot rendered by `ChangeRow`.

## Supported project layouts
The detector (`crates/l10n/src/detect.rs`) looks for catalogs in these places and treats everything else as not a catalog:
- `src/localization/modules/<ns>/<lang>.json` (one folder per namespace), `locales/<lang>.json` and `locales/<ns>/<lang>.json`, `src/localization/<lang>/<ns>.json`. Flat or nested JSON, one key per line, i18next `{{placeholders}}`, `_one/_other` plurals.
- Changelogs for the release assistant are read from `src/components/modules/whatsNew/changelog.json` or `app/components/changelog.json` (`crates/l10n/src/release.rs`): `{ "$comment", "releases": [ { version, date, highlight{lang}, groups[ { type, items[ { title{lang}, description{lang} } ] } ] } ] }`, newest first, missing languages fall back to `en`. Other layouts are not detected; bring-your-own paths are not supported in this version.

## Checker
Changed files come from `git status`. Per locale file the key diff is HEAD vs working tree; changed code is scanned for `t('...')`, `i18n.t`, `$t`, `i18nKey=` (added lines only, whole file when untracked; dynamic keys skipped). Every candidate key is evaluated for every language: missing, placeholder set differs from the reference language, plural forms the language needs (CLDR table in `rules.rs`), or no catalog file. Output is per group (namespace) rows and a per-file badge list; values are never dumped (reference text is capped).

"Translate missing" runs one tool-less Haiku `claude -p` call from an empty temp directory (batches of 40, 150 s timeout, refused under `INTELY_READONLY`; `INTELY_L10N_FAKE=1` returns deterministic stand-ins). Drafts land in a review list; a draft whose placeholders differ is flagged and cannot be bulk-accepted. `l10n_apply` writes only accepted keys, each as one spliced line (`catalog::set_key`: appended as the last key, or the value replaced in place), verifies that all other keys are unchanged and the result is valid JSON, writes atomically, and passes `Jail::check_op`. It refuses any path that is not a detected catalog.

## Release assistant
Base = the tag named like the current version, else the commit that set the current `package.json` version (`git log -S`), else the last commits. Commits are classified by conventional prefix (feat, fix, perf, security, refactor/style, chore/docs/test/ci = internal), merges and release bookkeeping are skipped. The proposal is a minor bump when there is a feature (major on `!`), otherwise patch; the human can pick patch/minor/major. The entry is drafted in English; "Translate" fills the other languages through the same draft backend. The diff is shown before `l10n_release_apply` (jail-checked) splices the entry into the top of `releases` and sets `version` in `package.json`. Nothing commits or tags; the tag command is only displayed.
