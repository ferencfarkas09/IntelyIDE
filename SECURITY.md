# Security policy

This page explains how to report a vulnerability in IntelyIDE and what to expect afterwards.

## Supported versions

Only the latest 1.x release and the `main` branch receive security fixes. Older releases are not patched; update to the latest release. IntelyIDE is maintained by one person.

## How to report

Report privately through GitHub private vulnerability reporting:
[Report a vulnerability](https://github.com/ferencfarkas09/IntelyIDE/security/advisories/new)

If that page is not available to you, open a [GitHub Discussion](https://github.com/ferencfarkas09/IntelyIDE/discussions) that asks the maintainer for a private channel. Write only that you have a security report and give no details in the discussion. The maintainer will answer with a way to send the details privately on GitHub.

Never open a public issue, discussion or pull request for a vulnerability.

Please include:

- the IntelyIDE version or commit,
- your macOS version and CPU architecture,
- the steps to reproduce,
- the impact you see,
- whether write mode was on.

Remove private data (repository names, paths, tokens, URLs with credentials) from anything you send. If a report needs a log, note that `refusals.log` and the run logs can contain full command lines and file contents: read and redact them first.

## What to expect

This is a one-maintainer project, so these are best-effort targets, not guarantees:

- acknowledgement within 7 days,
- a fix or a mitigation plan within 30 days for confirmed issues,
- coordinated disclosure, 90 days by default, shorter when a fix ships earlier,
- credit in the advisory unless you ask not to be named,
- no bug bounty.

## Scope

In scope:

- any way for an agent to commit, push or otherwise change Git history, including a bypass of the `git` shim, a bypass of a policy hard stop, or writes to protected paths (also indirect ones),
- escaping read-only mode or the test jail,
- leaking credentials: Keychain items, logs, URLs, the Remote pairing and relay protocol,
- path traversal or server-side request forgery in the preview proxy,
- a bypass of the Agent SDK verification (the sidecar loader or the in-app installer),
- release integrity: a DMG that does not match the `SHA256SUMS` of its release, or a release asset that was changed after publication,
- the packaging of the sidecar and the Agent SDK installer inside the app,
- any `INTELY_*` test hook that is active in a release build,
- escapes from the Content Security Policy or the preview iframe,
- secrets in published artifacts.

Out of scope:

- attacks that need a malicious local user who already controls your account,
- the behaviour of third-party agents' own command-line tools,
- vulnerabilities in dependencies without a demonstrated path to IntelyIDE (report them upstream; Dependabot tracks them),
- Gatekeeper prompts on ad-hoc signed builds (documented and expected),
- social engineering,
- denial of service by very large repositories.

The protections against agent actions are layered and best-effort. They are not a sandbox, and a report that shows a gap in them is welcome and in scope.

## If a release is compromised

If a release is suspected to be compromised, the maintainer will yank it, publish a security advisory and state the problem at the top of the README.

You will learn about a fixed release from the in-app update notice (a notice, never a silent install), the GitHub release notes and the Security advisories page of the repository. The Agent SDK pin changes only with a new release.

## Good-faith research

If you act in good faith, test only on your own machine and your own repositories, and do not access or disclose other people's data, I will not take legal action against you for your research. Do not test against other people's systems.
