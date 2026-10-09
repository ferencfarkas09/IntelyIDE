# Getting help

This page explains where to ask questions and how to report problems with IntelyIDE.

## Questions and ideas

- Read the [FAQ and troubleshooting guide](docs/faq.md) first; it covers the common install and first-run problems.
- Ask usage questions and share ideas in [GitHub Discussions](https://github.com/ferencfarkas09/IntelyIDE/discussions) (Q&A category).
- Product information and downloads are on [intelyhome.com](https://intelyhome.com).
- Feature requests go to [GitHub Issues](https://github.com/ferencfarkas09/IntelyIDE/issues/new/choose) with the feature request form.

## Bug reports

Use the bug report form in [GitHub Issues](https://github.com/ferencfarkas09/IntelyIDE/issues/new/choose). A good report has:

- the IntelyIDE version or commit, your macOS version and your CPU architecture (Intel or Apple silicon),
- whether the app was in read-only or writing mode, and which agent provider you used, if any,
- numbered steps that reproduce the problem, what you expected and what happened,
- relevant log excerpts.

Remove private data before you paste anything: repository names, paths, tokens and URLs that contain credentials. The files `refusals.log` and `runs/*.jsonl` can hold full command lines and file contents; read and redact them first.

## What we cannot help with

- Forks and unreleased builds. Please reproduce the problem on a published release or on `main`.
- Problems in third-party tools that IntelyIDE only launches, such as agent command-line tools or Git itself.

IntelyIDE is maintained by one person. Expect a first reply within about a week; there is no support contract and no guaranteed response time.

## Security and conduct

- Security problems: do not open a public issue. Use [private vulnerability reporting](https://github.com/ferencfarkas09/IntelyIDE/security/advisories/new) as described in [`SECURITY.md`](SECURITY.md).
- Conduct problems: see [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
