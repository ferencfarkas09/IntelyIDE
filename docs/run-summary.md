# Run summary

The run summary tells you in plain words what a finished agent run did: which kinds of files it changed, which commands it ran, what you should check now and what may be risky. You do not have to read the diff or the transcript to get the gist. Applies to version 1.14.0.

It is a lazy extra that starts switched on. Settings > Run summary turns it off; while it is off nothing is built, fetched or shown.

## Where you see it

- **What this run did**: a card at the top of a finished run's page (a run that is done, or that stopped with an error). Click its title to fold it; the app remembers that choice.
- **A chip on the run card** in the sessions list, for example `5 files · 2 risks`. It takes the warning colour when the run has at least one risk.
- **Show run summary** in the command palette scrolls to the card of the selected run and unfolds it.

The card is fetched again when the run's status changes, for example when you send the run another message and it finishes again.

## What it shows

**What this run did**: three to six short sentences, such as "Changed 4 screen files and 2 style files", "Added 1 new package: axios", "Ran 3 commands, 1 of them failed" and the first line of the agent's last message. Files are grouped by what they are for:

| Group | Examples |
|---|---|
| Screens and components | `.tsx`, `.jsx`, `.vue`, `.svelte`, files under `components/`, `screens/`, `pages/`, `app/` |
| Styles | `.css`, `.scss`, `.sass`, `.less`, `*.styles.ts`, styled files |
| Tests | `*.test.*`, `*.spec.*`, `__tests__/`, `e2e/` |
| Settings | `tsconfig.json`, Babel, Metro, Vite, webpack, ESLint and Prettier configs, `app.json`, `Podfile`, `build.gradle`, `Info.plist`, `AndroidManifest.xml`, entitlements, YAML and TOML files, `.env` files |
| Packages | `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Podfile.lock`, `Cargo.lock`, `Gemfile.lock` |
| Documents | Markdown files |
| iOS and Android | files under `ios/` and `android/`, Swift, Objective-C, Kotlin, Gradle, Xcode projects |
| Server | code under `server/`, `api/`, `routes/` and similar folders |
| Code, images and fonts, other | the rest |

**What to check**: practical next steps, for example "Start the app with npm run dev and look at the changed screens", "Install the packages again before you start the app", "Rebuild the iOS app: native files changed, a reload is not enough" or "Run the tests with npm test". The script names come from the Run panel's list of your repository's scripts (only the names, never what a script contains).

**Risks**: things worth a second look, each with the files, package names or host names it is about:

| Risk | When it is shown |
|---|---|
| Settings files changed | A configuration file changed (see Settings above). |
| Locked package versions changed | A lockfile changed. |
| Environment file touched | A `.env` file changed. These often hold passwords and keys. |
| Permissions changed | An iOS usage description in `Info.plist`, an Android `<uses-permission>` in `AndroidManifest.xml` or an entitlements file changed, or the agent ran `chmod` or `chown`. |
| Files deleted | The run deleted files. |
| New packages installed | The agent ran an install command such as `npm install <name>`, `pnpm add`, `yarn add`, `npx expo install`, `pip install` or `cargo add`. Only the package names are shown, never versions or URLs. |
| Reached the internet | The agent used a web fetch or web search tool, or ran `curl` or `wget`. Only host names are shown, never the full address. |
| Tried to change the Git history | A `git commit`, `git push`, `git reset` or `git rebase` appeared in the agent's commands, whether or not the app's safety rules let it through. |
| Steps failed | A tool failed, the run reported an error or it stopped early. |
| Requests still open | A permission request or question of the run was never answered. |

## Where it comes from

The summary is built on your computer from the run's event log, the run's meta file and read-only Git (the same comparison with the safety snapshot taken before the run that the Morning brief uses). No AI model is involved and nothing is sent anywhere. When a repository has no snapshot, the summary falls back to the files the agent's tools wrote or deleted, without line counts.

Commands are listed with their first line only, at most ten, each shown once, and marked when they failed (with the exit code when the output names one). The plan the agent proposed, its task list and the first line of its last message are kept as short decisions.

## Explain in plain words

The **Explain in plain words** button opens the New run dialog with a prompt that asks for a short, non-technical explanation. The prompt holds only the facts of the summary described above: the run's title, the file counts and example paths, the command lines, the decisions, the risks and the failure lines. It never holds the rest of your prompts, the agent's replies or the contents of files. Nothing starts until you press Start run, and you choose the role and model as usual; a small, fast model is enough.

## Storage

The summary of a finished run is kept as a small JSON file next to the run's log, `runs/<run id>.digest.json` in the app's data folder, readable only by you (permissions 0600) and written in one step so it is never half written. It is at most 64 KB: example paths are dropped first when a run did a lot. It records the size and time of the run's log, so it is rebuilt when the log changes. A run that is still working gets a summary on request but it is not stored. Nothing is ever written into your repositories.

## Limits

- Files are grouped by their names and folders, not by what is inside them, so an unusual layout can land in the wrong group.
- The Git comparison is made when the summary is first built after the run finished, against the working tree at that moment: changes you made by hand before that count as well.
- Packages, hosts and Git commands are recognised in the usual command forms only; a script that installs packages or calls the internet on its own is not seen.
- Permission changes inside `Info.plist` and `AndroidManifest.xml` are recognised from the agent's edits in the log; when the log does not show the edit, the file is listed as a settings change.
- The summary of a deleted run log is removed the next time it is asked for.

## Privacy

Every text in the summary (paths, command lines, decisions, failure lines) goes through the same secret masking as the Morning brief and session search, so tokens, passwords and keys show as `***`. Package names and host names are shown without versions, user names, ports or paths. The summary stays on your computer; it leaves only if you press Start run on the Explain in plain words prompt, and then only the masked facts go to the model provider you chose.
