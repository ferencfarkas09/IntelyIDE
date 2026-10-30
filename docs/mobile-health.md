# Mobile health

The Mobile health panel checks the iOS and Android parts of a repository (an Xcode project, a Podfile, Gradle files, manifests, signing, permissions) and explains every problem it finds in plain language, with the file and line. It is written for people who build apps mostly by prompting coding agents and rarely read the project files themselves. Applies to version 1.14.0.

It is a lazy extra that starts switched on. Open it with the command palette (Open Mobile health); the command appears only when a repository of the workspace holds an iOS or Android project (an `ios` or `android` folder, an Xcode project, or a Gradle build). Settings > Mobile health turns the panel off.

## Read-only

The panel only reads. It never edits a file, never starts a process (no `xcodebuild`, no `pod`, no `gradle`, no `adb`) and never uses the network. Each finding has an Ask agent to fix button that opens the New run dialog with a prefilled prompt; nothing runs until you press Start run there, and the prompt tells the agent to change only what the finding needs, not to commit or push, and not to print secrets.

## What it reads

| Where | What is looked at |
|---|---|
| `project.pbxproj` | the development team, signing style and provisioning profile, bundle identifiers across targets and configurations, the minimum iOS version, the version and build number, the entitlements file |
| `Info.plist`, `.entitlements` | permission texts (camera, photos, location, microphone, contacts, Face ID, Bluetooth), the push notification entitlement |
| `Podfile`, `Podfile.lock`, `Pods/Manifest.lock`, `Podfile.properties.json` | the platform version, whether the Pods are installed and in step with the lock file, New Architecture and Hermes flags |
| `.xcode.env` | whether it exists and whether it points to one person's home folder |
| `build.gradle`, `build.gradle.kts`, `libs.versions.toml` | `compileSdk`, `targetSdk`, `minSdk`, `namespace`, `applicationId`, `versionCode`, `versionName`, signing configs, the Android Gradle plugin version |
| `gradle.properties`, `local.properties`, `gradle-wrapper.properties` | New Architecture and Hermes flags, AndroidX, plain-text passwords (by name only), the SDK location, the Gradle version |
| `AndroidManifest.xml` | declared permissions, `debuggable`, cleartext traffic |
| `package.json`, `app.json` | dependencies that imply a permission, the React Native version, Expo's version and identifiers |
| `.env*` | the file names only; the content is never opened |

Expo's `app.config.js` and `app.config.ts` are code, so they are never run; the panel says that it could not compare them.

## Findings

Every finding has a severity (error, warning or note), an explanation for a non-expert, the file and line, and sometimes a confidence label.

- **Error**: the build, the signing or the store upload will fail (for example a release build signed with the debug key, a missing `namespace`, a Gradle too old for its Android Gradle plugin, Pods out of step with `Podfile.lock`).
- **Warning**: likely to cause trouble (for example no development team, different bundle identifiers in Debug and Release, a missing permission text for a package that needs one).
- **Note**: worth knowing (for example iOS and Android on different versions, a permission that nothing seems to use).

A finding marked with a confidence label is a guess. Permissions are inferred from package names in `package.json` (such as `expo-camera` or `react-native-vision-camera`) and from calls in the project's own native code (such as `CLLocationManager`), and the table behind this is `crates/mobilehealth/tables/permissions.json`. Confidence is high for native code, medium for a package that exists to use the permission, and low for a package that only might. JavaScript can ask for a permission in ways neither source shows, and many Android libraries add their permissions to the app themselves, so check before acting.

### Cross-platform checks

The panel compares the iOS version with the Android `versionName`, the iOS bundle identifier with the Android `applicationId`, the New Architecture and Hermes flags of both platforms, and Expo's `app.json` against the native projects. Different values are not always wrong (the two apps may ship separately), so these are notes or warnings that ask whether the difference is intended. Build numbers are not compared: the two stores count them separately.

### Secrets

A plain-text password in a Gradle file or in `gradle.properties` is reported by the name of the setting and the file and line, never by its value. The well-known password of the standard debug keystore is not reported. A `.env` file is reported when no `.gitignore` rule covers its name; its content is never read. The `.gitignore` reading is approximate (plain names and `*` or `?` patterns in the repository's own files).

## Store readiness

The checklist lists what can be seen in the repository: the 1024 px App Store icon, the iOS privacy manifest (`PrivacyInfo.xcprivacy`), a launch screen, the Android launcher icon, store screenshots, and the Android `targetSdk`. Screenshots often live outside the repository, so their absence is shown as Check, not as a failure.

Store requirements change. The panel does not assert a policy or a date: where a level is involved it shows the value noted in its own table together with the date that table was last reviewed, and tells you to check the current requirement on the store's own page. The tables are `crates/mobilehealth/tables/store.json` (the Google Play target level) and `crates/mobilehealth/tables/compat.json` (the oldest Gradle each Android Gradle plugin version needs). The reviewed dates are shown at the bottom of each repository. An Android Gradle plugin version that is not in the table is reported as unknown, never as wrong.

## Limits

- Where the project is. It finds projects up to three folders below the repository root (so `apps/mobile` works) and reads the native folders of each (`ios`, `android`, `fastlane` and the like). It skips `node_modules`, `Pods`, `build`, hidden folders and dependency folders, and shows at most eight projects per repository.
- Values that are computed (a variable, a function, a Groovy expression) cannot be read and are left out rather than guessed. A setting that comes from an `.xcconfig` file other than CocoaPods' own is treated as unknown, so a "missing" is never reported for it.
- Flutter projects are read for their native files only; Flutter's own version fields are variables there and are not compared.
- A scan has a time budget of a few seconds per repository (and a ceiling on the bytes it reads). A very large or unusual repository stops early, and the panel says so instead of waiting. Repositories are scanned one at a time, so a slow one does not hold up the others. A folder with thousands of entries is read in part (the well-known project files are always among the entries looked at) and the panel names it.
- `ANDROID_HOME` is read from the environment of the app itself. A macOS app started from the Dock does not inherit the variables of a shell, so an unset value is shown as a note, not a warning.
- The stock templates are not errors. A build script that only declares the Android application plugin for its modules (`apply false`) is not a module, and a module whose levels or namespace may come from a convention plugin of its own gets a note, not an error. The React Native template signs its release build with the debug key; that is a warning.
- The checks do not replace a real build. A clean report means the files look consistent, not that Xcode or Gradle will succeed.

## Safety and privacy

Repositories are treated as hostile input. Files are opened through directory handles that do not follow symbolic links, so a link in a repository cannot lead the panel to a file outside it. Only regular files are read, none larger than 4 MB (8 MB for the two Pods lock files); a larger file, a link or a special file is named in the panel and skipped. Every walk has a limit on folders, depth and file count, and the readers for project files, property lists and XML stop at fixed depths, so a deeply nested or oversized file cannot stall or crash the scan. Invalid UTF-8 is tolerated. Every value read from a file is put on one line and stripped of backticks, control, bidirectional and invisible characters and cut to 200 characters before it can appear in a finding or in a prompt for an agent, and a prompt tells the agent that text in backticks is data copied from files, never instructions.

Nothing is sent anywhere. The scan runs on your computer, writes nothing, and does not log file contents; the report stays in the app. The text of a finding is built from file names, line numbers and short values such as versions and identifiers, never from a secret. When you press Ask agent to fix, the prompt is handed to the New run dialog, and what the agent then does is governed by the usual safety layers of the app, as for any run.
