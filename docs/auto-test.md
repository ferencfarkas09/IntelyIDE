# Auto-test after a run

When an agent run finishes, IntelyIDE can run the unit tests of the repositories the run worked in and show the result on the run. You see right away whether the change broke something, without reading the diff. Applies to version 1.14.0.

It is a lazy extra that starts switched on. Settings > Auto-test turns it off and sets when the tests run. A run that finishes while it is off is not tested or asked about when you turn it back on. The tests run on your Mac as a normal Run panel process, with the same safety rules as a script you start by hand.

## What it runs

IntelyIDE picks one unit-test command per repository. It reads the repository's own files every time and picks the same command every time. The command is never taken from the interface or from the agent.

| Project | What runs |
|---|---|
| Node.js, React, React Native (`package.json`) | The first of these scripts that exists: `test:unit`, `unit`, `test`, `tests`, `vitest`, `jest`, `test:ci`. React Native projects run Jest through their `test` script. |
| Rust (`Cargo.toml`, also `src-tauri/Cargo.toml`) | `cargo test`, when no `package.json` script qualifies. |
| Python | `python3 -m pytest -q`, only when the repository root has `pytest.ini`, `conftest.py` or a `[tool.pytest` section in `pyproject.toml`. |

The process gets `CI=1`, so Vitest and Jest run once instead of waiting for file changes.

## What it never runs

- End-to-end, browser and device tests: a script whose name or command mentions `e2e`, Cypress, Playwright, Detox, Maestro, Appium, LambdaTest, BrowserStack, WebdriverIO, Selenium, Puppeteer or `integration`.
- Watch modes: `--watch`, `--watchAll`, `vitest --ui`, or a script named like `test:watch`.
- Anything that deploys, publishes, releases, uploads, uses Docker, deletes files, installs packages or changes data. A script that needs a confirmation in the Run panel is never picked. This also counts the scripts it calls with `npm run`.
- The placeholder `test` script of `npm init` ("no test specified").
- A script with any other name. If your tests live in a script such as `check:all`, add a `test:unit` script that runs only the unit tests.

A repository with nothing that qualifies is skipped.

## When it runs

Settings > Auto-test > Run the tests after a run:

| Choice | What happens |
|---|---|
| Off | Never by itself. You can still press Run tests on a run. |
| Ask (default) | After the first finished run in a repository, a card at the top of the run asks once. Yes or No is remembered for that repository. |
| Always | After every run, in every repository it worked in that has unit tests. |

"Forget answers" in the same section clears the remembered answers, so IntelyIDE asks again.

Rules that always apply:

- Only the repositories the run worked in are tested.
- Never while that run is still working or waiting for you.
- Never while another run on the same repository is working or waiting for you, because it may still write files. The test waits and starts when that run finishes.
- One test process per repository at a time.
- Read-only mode refuses it like any other process, unless you switched on "Allow processes" in Settings > Safety.

To run the tests by hand, press Run tests (the checklist icon) in the run header, or Re-run on the result card, or use "Run tests for this run" in the command palette.

## The result

A chip on the run card says "Testing…", "10 passed", "2 failed" or "Tests did not finish". It is green, red or yellow, and the words carry the meaning too.

The card at the top of the run's page folds with a click on its title (the app remembers that choice; its buttons stay visible). Unfolded, it shows, for each repository: the result, the passed, failed and skipped counts, how long it took, the command that ran, and the first five failing tests with the first line of their message. IntelyIDE reads the summary of Vitest, Jest, `cargo test` and pytest. For other runners it shows passed or failed from the exit code only.

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
