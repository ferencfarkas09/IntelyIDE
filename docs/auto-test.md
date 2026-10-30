# Auto-test after a run

When an agent run finishes, IntelyIDE can run the unit tests of the repositories the run worked in and show the result on the run. You see right away whether the change broke something, without reading the diff. Applies to version 1.14.0.

It is a lazy extra that starts switched on. Settings > Auto-test turns it off and sets when the tests run. The tests run on your Mac as a Run panel process: the same jail, read-only mode and log masking as a script you start by hand, but with a smaller environment (see "Trust and environment").

A test command is the repository's own code: a `test` script in `package.json`, a `build.rs` of `cargo test` or a `conftest.py` can do anything your user can do on this computer. That is why nothing runs by itself before you trusted the repository.

## What it runs

IntelyIDE picks one unit-test command per repository. It reads the repository's own files every time and picks the same command every time. The command is never taken from the interface or from the agent.

| Project | What runs |
|---|---|
| Node.js, React, React Native (`package.json`) | The first of these scripts that exists: `test:unit`, `unit`, `test`, `tests`, `vitest`, `jest`, `test:ci`. React Native projects run Jest through their `test` script. |
| Rust (`Cargo.toml`, also `src-tauri/Cargo.toml`) | `cargo test`, when no `package.json` script qualifies. |
| Python | `python3 -m pytest -q`, only when the repository root has `pytest.ini`, `conftest.py` or a `[tool.pytest` section in `pyproject.toml`. |

The process gets `CI=1`, so Vitest and Jest run once instead of waiting for file changes.

## Trust and environment

- **A trust question first, in every mode.** Before a repository's test command runs by itself for the first time, a card at the top of the run names the exact command (the runner, for example `npm run test`, and what it runs, for example `vitest run`, with secrets masked) and says that it runs the repository's own scripts. Only **Trust and run** lets it run; the trust is stored for that repository in `settings.json` (namespace `autotest`, key `trusted`) together with a fingerprint of the command. A remembered Yes from version 1.14.0 is not trust: the card asks again.
- **A changed command asks again.** When the script, or a script it calls with `npm run`, changes after you trusted it, the fingerprint no longer matches and the card comes back. The backend checks the fingerprint again right before the start and refuses a command that changed in between.
- **A smaller environment.** The test process starts from an empty environment with only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `TMPDIR`, `LANG`, `LC_*`, `NVM_DIR`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `CARGO_HOME`, `RUSTUP_HOME` (and the Windows system variables), plus `CI=1`. `SSH_AUTH_SOCK`, tokens, cloud credentials and anything else your shell exports are not passed. A script you start by hand in the Run panel still gets your full environment.

## What it never runs

- End-to-end, browser and device tests: a script whose name or command mentions `e2e`, Cypress, Playwright, Detox, Maestro, Appium, LambdaTest, BrowserStack, WebdriverIO, Selenium, Puppeteer or `integration`.
- Watch modes: `--watch`, `--watchAll`, `vitest --ui`, or a script named like `test:watch`.
- Anything that deploys, publishes, releases, uploads, uses Docker, deletes files, installs packages or changes data. A script that needs a confirmation in the Run panel is never picked. This also counts the scripts it calls with `npm run`.
- A script that shells out or reaches the network: `curl`, `wget`, `ssh`, `scp`, `rsync`, `nc`, `sudo`, `eval`, an inline shell or interpreter (`sh -c`, `bash -c`, `node -e`, `python -c`), a package runner that fetches code (`npx`, `bunx`, `pnpm dlx`, `yarn dlx`, `npm exec`), `git push`, Docker or Podman. This list cannot be complete; the trust question is what protects you.
- The placeholder `test` script of `npm init` ("no test specified").
- A script with any other name. If your tests live in a script such as `check:all`, add a `test:unit` script that runs only the unit tests.

A repository with nothing that qualifies is skipped.

## When it runs

Settings > Auto-test > Run the tests after a run:

| Choice | What happens |
|---|---|
| Off | Never by itself. You can still press Run tests on a run. |
| Ask (default) | After the first finished run that changed files in a repository, the trust card asks once. Trust and run, or No, is remembered for that repository. |
| Always | After every run that changed files, in every repository you trusted. A repository you have not trusted yet gets the trust card first, as in Ask. |

"Forget answers" in the same section clears the remembered answers and the trust, so IntelyIDE asks again before it runs any test command.

Rules that always apply:

- Only the repositories the run changed are tested. The run summary's count decides: a repository with no changed files, or one whose changes could not be checked (no snapshot, no git), is not tested by itself.
- Never for a read-only run (permission mode Plan / read-only): it wrote nothing to test.
- Never for a run on a server. Its changes are in the server's copy, so testing the copy on this computer would say nothing about them; the result card says "Not tested: this run worked on a server", and Run tests is not offered for such a run.
- Never while that run is still working or waiting for you.
- Never while another run on the same repository is working or waiting for you, because it may still write files. The test waits and starts when that run finishes.
- One test process per repository at a time.
- Read-only mode refuses it like any other process, unless you switched on "Allow processes" in Settings > Safety.

To run the tests by hand, press Run tests (the checklist icon) in the run header, or Re-run on the result card, or use "Run tests for this run" in the command palette.

## The result

A chip on the run card says "Testing…", "10 passed", "2 failed" or "Tests did not finish". It is green, red or yellow, and the words carry the meaning too.

The card at the top of the run's page shows, for each repository: the result, the passed, failed and skipped counts, how long it took, the command that ran, and the first five failing tests with the first line of their message. IntelyIDE reads the summary of Vitest, Jest, `cargo test` and pytest. For other runners it shows passed or failed from the exit code only.

The full output is in the Run panel, like any other script.

## Asking the agent to fix it

When tests failed, the card offers "Ask the agent to fix the failing tests". It opens New run with a prompt that lists the failing tests and their messages, and selects the repositories that failed. Nothing starts until you press Start, and you can edit the prompt first. The prompt asks the agent to fix the code, not to delete or weaken the tests.

## Limits

- A test run is stopped after 5 minutes and shown as "Stopped after 5 minutes".
- Only one command per repository. A monorepo whose tests live in each package needs a root script that runs them.
- The result is kept until the app quits. It is not saved.
- If the test script is already running in the Run panel, the start is refused. Stop it there and press Re-run.
- The counts come from the runner's summary line. A log that was cut short, or a runner that prints its own format, shows the result without counts.

## Privacy

Everything happens on your machine. The test output stays in the IDE and is masked like every Run panel log: tokens, passwords and keys are replaced with `***`. Nothing is sent anywhere. Only when you start the fix run do the failing test names and their first message lines go to the agent's provider, like any prompt you type. They are masked a second time before they go into the prompt.
