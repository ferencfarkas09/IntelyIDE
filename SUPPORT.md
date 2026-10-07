# Getting help

This page explains where to ask questions and how to report problems with IntelyIDE.

## Questions and ideas

- Read the [FAQ and troubleshooting guide](docs/faq.md) first; it covers the common install and first-run problems.
- Ask usage questions in the Q&A category of GitHub Discussions on this repository. If Discussions is not enabled yet, open an issue and use the `question` label.

## Bug reports

Use the bug report form in the issue tracker. A good report has:

- the IntelyIDE version or commit, your macOS version and your CPU architecture (Intel or Apple silicon),
- whether the app was in read-only or writing mode, and which agent provider you used, if any,
- numbered steps that reproduce the problem, what you expected and what happened,
- relevant log excerpts.

Remove private data before you paste anything: repository names, paths, tokens and URLs that contain credentials. The files `refusals.log` and `runs/*.jsonl` can hold full command lines and file contents; read and redact them first.

## What we cannot help with

- Forks and unreleased builds. Please reproduce the problem on a published release or on `main`.
- Problems in third-party tools that IntelyIDE only launches, such as agent command-line tools or Git itself.

IntelyIDE is alpha software maintained by one person, so replies can take a while.

## Security and conduct

- Security problems: do not open a public issue. Follow [`SECURITY.md`](SECURITY.md).
- Conduct problems: see [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
