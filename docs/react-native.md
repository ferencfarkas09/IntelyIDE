# React Native panel

The React Native panel is the device loop for React Native and Expo apps: what the project is, Metro, the iOS simulators, Android emulators and phones, the logs of the running app, and plain-language cards for the errors that usually stop an app, each with a Fix with agent button. Applies to version 1.14.0.

It is a lazy extra that starts switched on, but the panel only appears when the workspace holds a React Native or Expo project. Open it with the command palette (Show or hide the React Native panel) or the rail button at the bottom; Settings > React Native turns the extra off, which also stops a device log stream that is still running. Nothing starts by itself: Metro, builds and log streams start only when you press a button.

## When the panel appears

A repository counts as a React Native or Expo app when its `package.json` depends on `react-native` or `expo`, and it has an `ios/` folder, an `android/` folder, or an `app.json` / `app.config.js` / `app.config.ts`. The workspace is checked when it opens and when its repositories change; the refresh button in the panel header checks again (for example after an agent created the project). With several such repositories a selector at the top picks one.

## Status card

| Fact | Where it comes from |
|---|---|
| React Native and Expo version | the installed package in `node_modules`, else the range in `package.json` |
| New Architecture | `newArchEnabled` in `android/gradle.properties`, `ios/Podfile.properties.json` or `app.json`; when none sets it, the default of the React Native version (on from 0.76) |
| Hermes | `hermesEnabled`, the `jsEngine` setting of Expo, else the default of the version (on from 0.70) |
| Package manager | the lock file: `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, else npm |
| iOS Pods | `ios/Pods/Manifest.lock` against `ios/Podfile.lock`: installed, out of date, or not installed |
| Android SDK | `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `android/local.properties`, then the usual install folders |

A fact that cannot be told (for example a `latest` tag instead of a version) shows as unknown. Only small project files are read, each up to 2 MB, and `.env*` files are never opened. A path is read only when it still lies inside the repository after every symbolic link on the way is resolved, so a link such as `android -> /somewhere/else` is ignored (a pnpm `node_modules` link into the repository is fine).

## Metro

Start, Stop, Restart and Reload app act on the `package.json` script that starts Metro: the script called `start` (or `dev`) whose command contains `expo start` or `react-native start`. The script runs through the same runner as the Run panel, so everything there applies: the "Allow processes" switch in read-only mode, the detected port, the memory chip, the masking of secrets in the output, and the one-click Stop. Metro shows in the Run panel as well. If the project has no such script, the panel says which one to add.

Reload app asks the running Metro server to reload the app with one request to `127.0.0.1`. The port is never one the script printed: it must be a port that `lsof` found listening in the server's own process tree and that Metro is configured for (8081, 19000, the `--port` of the start script, or `RCT_METRO_PORT`). Nothing leaves the machine, and the button is off until such a port is known.

## Devices

The device lists come from three optional tools, looked up on the `PATH` of your login shell and in the Android SDK:

| Tool | Gives | If it is missing |
|---|---|---|
| `xcrun simctl` (Xcode) | iOS simulators, with boot and shut down | the iOS part shows how to install Xcode; on other systems it says that simulators need a Mac |
| `emulator` (Android SDK) | Android virtual devices (AVDs), with boot | the panel says which SDK Tools package to install |
| `adb` (Android platform-tools) | connected emulators and phones, with shut down for emulators | the panel says to install the platform-tools and set `ANDROID_HOME` |

A missing tool is a normal state with a hint, never an error. A phone that needs the USB debugging prompt accepted shows as unauthorized. Only emulators can be shut down from the panel, never a phone. Booting an AVD opens the emulator window; it is left running when you close IntelyIDE.

Run app builds the native app and installs it on the device: it runs the project's `ios` or `android` script (for example `expo run:ios` or `react-native run-android`). Such a script is a build, so it asks for a confirmation first, lists why, and is never started by an agent; this holds for any script that runs `expo run:*`, `react-native run-*` or `build-*`, `xcodebuild`, `expo prebuild`, `eas build` or `eas submit`, `pod install`, `fastlane` or `gradlew assemble*` / `bundle*` / `install*`, whatever it is called and however it reaches them (through another script, with flags in between, in a workspace command, in a `pre` or `post` hook, or after `&&`). The CLI picks the device (the booted simulator, or the one it asks for); the panel passes no arguments.

## Device logs

Start under Device logs follows the log of the booted simulator or the chosen device:

- iOS: `xcrun simctl spawn <device> log stream --style compact` with a predicate on the app process (the name of the Xcode project, or Expo Go when there is no `ios/` folder) and the React Native log subsystem.
- Android: `adb logcat` limited to `ReactNative`, `ReactNativeJS`, `AndroidRuntime`, `DEBUG` and `libc`, starting with the last 200 lines.

Lines go into a ring that keeps at most 2000 lines and 1 MiB per platform and counts what it dropped. Each line is cut at 2000 characters and passed through the secret masker before it is stored, so a token in a log line never reaches the screen, the clipboard or a prompt. The chips show all lines, warnings only, or errors only; Copy copies the lines shown; Clear empties the ring. A stream ends when you press Stop, when the device goes away, or when IntelyIDE quits.

## Error cards

The panel reads the Metro output and both device logs for the failures that usually stop a React Native app and shows each as a card with a plain explanation, the line that matched, and a Fix with agent button:

| Card | What it recognises |
|---|---|
| Red screen | `Invariant Violation` |
| A file or package cannot be found | `Unable to resolve module` |
| Something that does not exist was used | `undefined is not a function`, `Cannot read properties of undefined` |
| A JavaScript error | `TypeError`, `ReferenceError` and unhandled promise rejections |
| The app crashed | `FATAL EXCEPTION`, `Fatal signal`, `Terminating app due to uncaught exception` |
| The Android build failed | Gradle failures, `SDK location not found` |
| The iOS build failed | `** BUILD FAILED **`, compiler and signing errors |
| The app cannot reach Metro | `No bundle URL present` |
| The Metro port is already in use | `EADDRINUSE`, port in use |
| The iOS Pods are out of date | `The sandbox is not in sync with the Podfile.lock` |

The same error is one card with a count; Dismiss hides a card. Fix with agent opens the New Run dialog with a prompt that holds the error, a few lines after it and the app's name and version. The log lines in it are stripped of control and invisible characters, put in a fence that nothing inside can close, and introduced to the agent as untrusted output, because a repository decides what its scripts print. It only fills the form: nothing runs until you press Start run, and you choose the role.

## Safety and privacy

- Repositories are untrusted. The panel reads dependency versions and script commands from `package.json` to find the right scripts; a script command is never shown or sent anywhere. Metro and builds start only from your click, through the runner and its jail.
- Every program the panel itself starts (`xcrun`, `adb`, `emulator`, `open`) goes through the same "Allow processes" check as the Run panel, with a fixed argument list. A simulator id, an AVD name or an adb serial is checked against its expected shape first, so a name taken from a tool's output can never become an option or a shell command. No shell is involved.
- The only network call is Reload app, to `127.0.0.1`. The panel sends nothing to any server, and adds no telemetry.
- Logs are masked before they are stored; the ring lives in memory and is gone when you quit.
- No agent can reach any of this: the panel's commands are buttons, not agent tools.

## Limits

- Metro and the app builds need the matching scripts in `package.json`. Both `create-expo-app` and `react-native init` projects have them.
- The panel starts and follows what the tools report; it does not install Xcode, CocoaPods, Android Studio or an SDK.
- Only iOS simulators are listed, not iPhones; use the Xcode device list for those. Android phones need USB debugging.
- A Windows build of IntelyIDE shows the Android parts; the iOS parts need a Mac.
