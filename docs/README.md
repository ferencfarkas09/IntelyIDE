# Documentation index

This page lists every public document of IntelyIDE with a one-line description and the audience it is written for. Applies to version 1.14.0.

Audiences: **users** run the app, **contributors** change the code, **maintainers** publish releases.

| Document | What it covers | Audience |
|---|---|---|
| [Getting started](getting-started.md) | Install, run modes, the Welcome screen, workspaces, read-only versus writing, a first commit in a throwaway repository | users |
| [FAQ and troubleshooting](faq.md) | Common questions, fixes, where state and logs live, resetting, uninstalling, reporting bugs | users |
| [Install on macOS](install-macos.md) | Choosing and verifying the DMG, the Gatekeeper prompt, first-run notes, uninstall | users |
| [Install on Windows](install-windows.md) | Building and running on Windows 10/11: requirements, what differs | users |
| [Install on Linux](install-linux.md) | Building and running on Linux: requirements, what differs | users |
| [Safety model](safety.md) | The layers that protect your repositories, their limits and how they are tested | users, contributors |
| [Privacy](privacy.md) | What is stored, where, and what leaves your machine | users |
| [Internationalisation](i18n.md) | How the interface language works and how translations are produced | users, contributors |
| [Mongo Studio guide](mongo-studio-guide.md) | Using the MongoDB tools | users |
| [Preview and inspect](preview-inspect.md) | The embedded preview and element inspector | users |
| [Attachments](attachments.md) | Dropping and pasting files into a prompt, and the secret guard | users |
| [Runs on servers](remote-servers.md) | Running agents on your own servers over ssh: set up, repositories, where to run, limits | users |
| [Web tools](web-tools.md) | Design tokens, unused styles and React checks for CSS/SCSS and React projects, plus the element style panel of the preview | users |
| [Node tools](node-tools.md) | A route map of Node backends with a loopback-only Try it, .env comparison and an opt-in dependency check | users |
| [Versions panel](versions.md) | Seeing and changing the version of every repository in the workspace: package.json, Xcode and Android builds, Cargo and more | users |
| [Dashboard and widgets](dashboard.md) | The Dashboard tab and its cards, the plan usage in the menu bar and the Needs-You radar window | users, contributors |
| [Run picker](run-picker.md) | Choosing the exact model and effort of a run, and switching on ultracode, in New run | users |
| [Prompt library](prompt-library.md) | Saved prompts with placeholders, starter prompts for React, React Native, iOS, Android, Node and CSS, import and export | users |
| [Send to agent](send-to-agent.md) | Fix with agent and Explain this error from the terminal, logs, failed checks and the preview, with secrets masked | users |
| [Project notes](project-notes.md) | The CLAUDE.md of each repository and exactly what a run is told from it | users |
| [Setup doctor](setup-doctor.md) | Checking Node 24, the Agent SDK, the Claude Code login, Git and the iOS and Android tools | users |
| [Safety presets](safety-presets.md) | Careful, Balanced and Autonomous: plain names for the permission modes | users |
| [Checkpoints](checkpoints.md) | Save points during a run, Undo last step, comparing and restoring checkpoints, protecting ignored config files | users |
| [Auto-test after a run](auto-test.md) | Running the project's own unit tests when a run finishes, the result chip and asking the agent to fix failures | users |
| [Run summary](run-summary.md) | A plain-language digest of what a run did, what to check and what is risky | users |
| [Token saver](token-saver.md) | Keeping long runs cheaper: telling the agent about repeated reads, continuing in a fresh run, the cost of re-reading the conversation, token-saving habits | users |
| [React Native panel](react-native.md) | The device loop for React Native and Expo apps: Metro, simulators and emulators, device logs and error cards with a Fix with agent button | users |
| [Mobile health](mobile-health.md) | A read-only check of the iOS and Android parts of a project: signing, versions, permissions, Gradle and Pods, store readiness | users |
| [Notifications](notifications.md) | Banners and the Dock count when a run needs you | users |
| [Team](team.md) | Working with colleagues over your own relay: presence, shared runs, notes into a run, workspace snapshots, shared memory | users |
| [Remote with Cloudflare](remote-cloudflare.md) | Setting up the relay with your own Cloudflare account | users |
| [Remote gateway](remote-gateway.md) | How the remote gateway works | users, contributors |
| [Architecture](architecture.md) | Crates by role, the sidecar, the UI, data flow, state storage and testing | contributors |
| [Design system](design-system.md) | Tokens, components and rules for UI work | contributors |
| [Building](building.md) | Prerequisites, building from source, running tests | contributors |
| [Licensing](licensing.md) | The licence, header policy and the `pnpm licenses:*` commands | contributors, maintainers |
| [Localisation release](l10n-release.md) | Producing and checking the translated catalogs for a release | maintainers |
| [Releasing](releasing.md) | Versioning, changelog, release notes and publication | maintainers |
| [Release checklist](release-checklist.md) | The owner's checklist for a real release | maintainers |

Other files at the top of the repository: [README](../README.md), [CONTRIBUTING](../CONTRIBUTING.md), [CHANGELOG](../CHANGELOG.md), [SECURITY](../SECURITY.md), [SUPPORT](../SUPPORT.md) and [TRADEMARKS](../TRADEMARKS.md).
