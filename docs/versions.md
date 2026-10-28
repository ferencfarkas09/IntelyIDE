# Versions panel

The Versions panel shows the version of every repository in the workspace and changes several of them together, so a release does not mean opening `package.json`, an Xcode project and a Gradle file one by one. Applies to version 1.14.0.

It is a lazy extra that starts switched on. Open it with the command palette (Open Versions); Settings > Versions turns it off. The panel only reads until you press Apply, and it never commits, tags or pushes: the edited files show up in the Changes tab like any other edit.

## What it reads

| File | What is read and changed | Notes |
|---|---|---|
| `package.json` | the top-level `version` | The `package-lock.json` beside it changes too (its top-level version and the entry of the package itself), when it carries the same version. |
| Xcode `project.pbxproj` | `MARKETING_VERSION` (the version) and `CURRENT_PROJECT_VERSION` (the build number) in every target and build configuration | A value such as `$(inherited)` is skipped. |
| `Info.plist` | `CFBundleShortVersionString` and `CFBundleVersion` when they are written as text | A value such as `$(MARKETING_VERSION)` is read from the Xcode project, so nothing is listed for it. |
| Android `build.gradle`, `build.gradle.kts` | `versionName` and `versionCode` as plain values | A computed value is skipped. |
| `Cargo.toml` | `version` in `[package]` and `[workspace.package]` | `Cargo.lock` follows at the next plain `cargo build` or `cargo check`; a `--locked` build fails until then. |
| `tauri.conf.json` | `version` | Tauri 2 (top level) and Tauri 1 (`package.version`). |
| Expo `app.json` | `expo.version`, `expo.ios.buildNumber`, `expo.android.versionCode` | |
| `pyproject.toml` | `version` in `[project]` and `[tool.poetry]` | |
| Flutter `pubspec.yaml` | `version: 1.2.3+4`: the version and the build number after the plus sign | |

It looks in the root of each repository and in the folders below it, as deep as each kind of file needs: `package.json` and `tauri.conf.json` up to two folders down, `Cargo.toml`, Expo `app.json`, `pyproject.toml` and `pubspec.yaml` one folder down, and Xcode projects, `Info.plist` and Gradle files up to three folders down (so a Cargo workspace member such as `crates/x/Cargo.toml` is not listed). It skips `node_modules`, `Pods`, `build`, `dist`, `target`, `vendor`, other dependency and build folders, hidden folders and symbolic links. A file larger than 4 MB is not read and is named in the panel, and a value that is not a plain literal (a variable such as `$(MARKETING_VERSION)`, a tag, a line break, or more than 128 characters) is not listed.

## Changing versions

- **Patch, Minor, Major** in the header of a repository change every version of that repository; the same buttons next to All repositories change every repository. Each version is counted up from its own value, so a repository whose `package.json` is at `3.88.7` and whose Xcode project is at `1.2.3` gets `3.88.8` and `1.2.4` for a Patch. Build numbers are not touched by these buttons.
- **Build +1** counts every build number up by one (`45` becomes `46`, `12` becomes `13`).
- Type a version into any row (letters, digits, dots, hyphens and plus signs, at most 64 characters) to set that one file. A value the file could not hold is marked and refused: a version written without quotes (a JSON number such as `"version": 1.5`) takes a number with at most one dot, an Xcode project or `pubspec.yaml` takes no plus sign, and a build number is digits without a leading zero (Groovy would read `007` as octal), or use Set all versions to... to give every version of a repository the same value (build numbers stay as they are).
- The counting follows `npm version`: a pre-release such as `1.2.3-beta.1` is finished by a Patch (`1.2.3`), and by a Minor or Major only when nothing is below it (`1.3.0-beta.1` becomes `1.3.0`); build metadata after a plus sign is dropped. A version with two parts (`1.2`) keeps two parts for a Minor or Major and gains a third for a Patch (`1.2.1`). Something that is not numeric (`latest`, `v1.2`) or has more than three parts is not counted; type the value instead.
- A version of `0.0.0` is taken for a placeholder (a workspace package or tool that is never published). The buttons and Set all versions to... leave it alone, and it does not make a repository look out of step; type into its row to change it.
- A row marked "3 places, not all alike" is a value an Xcode project writes in several targets and configurations with different values. A change sets all of them.

A changed row is marked, and under Will change the panel shows the exact diff of every file, so you can read what would be written. A value the files would refuse (`../x`, an empty version, letters in a build number) is marked and keeps Apply off.

## Writing

Apply writes one repository after the other. Within a repository it is all or nothing: if the version of a file changed on disk since it was read ("changed since it was read"), the repository is left as it was and the panel says why; press the refresh button and decide again. Each file is written through a new temporary file in its own folder and renamed over the old one, and a file or folder that is a symbolic link is never followed or replaced (a repository can contain links, and Git keeps them): such a file is refused, and on macOS and Linux the folders are held open while the file is written, so a folder swapped for a link by another program in the middle of an Apply does not redirect the write out of the repository either, and a `package-lock.json` that is a link or larger than 64 MB is left alone. If putting the files already written back fails, the panel names the files that still hold the new version. A read-only file is refused (the panel names it) and nothing is written. Just before a file is replaced it is read once more, so a file edited in that moment is reported as changed instead of being overwritten. Only the characters of the version change. Indentation, quotes, line endings and everything around the value stay as they are, so the diff is the version lines and nothing else.

In the read-only safety mode the panel can read but not write.

## Limits

- Other places a version lives (`composer.json`, `pom.xml`, `setup.py`, podspecs, `gradle.properties`) are not read yet.
- A repository with more than 80 version fields shows the first 80 and says so.
- The panel does not decide what a release is. The Release tab drafts the changelog entry and the version for one repository; this panel is for setting the versions of many repositories fast.
