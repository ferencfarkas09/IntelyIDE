# Setup doctor

The Setup doctor checks whether the tools the agent and the usual mobile and web stacks need are installed, says why each one matters and gives the command that fixes it. Applies to version 1.14.0.

It is a lazy extra that starts switched on. Open it with the command palette (Open the setup doctor) or from Settings > Setup doctor. While the agent cannot start, the New Run dialog shows a card that leads here.

## What it checks

| Check | How | Needed for |
|---|---|---|
| Node.js 24 or newer | `node --version` on the login PATH | The agent (its sidecar runs on Node 24) and most JavaScript projects |
| Claude Agent SDK | The provider state the app already keeps (Settings > Providers > Claude) | The agent itself |
| Claude Code login | The same provider state; no credential is read | Agent runs |
| Git | `git --version` (hardened, outside any repository) | Everything |
| GitHub CLI (optional) | `gh --version` | Pull requests and CI status |
| Xcode command line tools | `xcode-select -p` | iOS builds, compilers on a Mac |
| CocoaPods (optional) | `pod --version` | Native iOS dependencies of React Native |
| Android SDK (optional) | `ANDROID_HOME`, else `ANDROID_SDK_ROOT`, else `~/Library/Android/sdk`, and `adb version` | Android builds, phones and emulators |
| Watchman (optional) | `watchman --version` | Faster file watching for Metro and Jest |

Each program is started once, on the login-shell PATH the IDE uses for its tools, in the file system root on macOS and Linux (never in a repository, never in a shared temporary folder), with a 10-second limit; once it has exited, its output is waited for at most 2 more seconds. Only its version is read. Nothing is installed, changed or sent over the network. An optional tool that is missing never makes the summary red.

On Windows (beta), Node.js, Git and gh are checked; the Xcode, CocoaPods, Android and watchman rows say "Not checked". The fix commands are for macOS with Homebrew; Windows gets `winget` commands for Node.js, Git and gh.

## Fixing

Every row that needs attention has a fix:

- A command you can **Copy** (for example `brew install node`, `xcode-select --install`, `brew install cocoapods`, or the two Agent SDK installer commands from Settings > Providers).
- For some commands, **Type it in a terminal**: a terminal tab opens in your home folder (never in a repository, whose own settings a tool such as `claude` would read) with the command typed in, and it runs only when you press Return there. Only fixed one-line commands are typed. Commands that change a startup file (pointing `ANDROID_HOME` at the SDK) are only shown to copy.
- Where there is no command, one sentence says what to do (install Android Studio and its Platform-Tools, for example).

Press **Check again** after a fix.

## Privacy

The doctor only looks at this computer. It reports versions and paths in the panel and keeps nothing; it reads no file contents, credentials or tokens.
