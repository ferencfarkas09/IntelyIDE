# Send to agent

"Fix with agent" and "Explain this error" turn an error you see in the IDE into the prompt of a new agent run, so you do not have to copy a log by hand. Applies to version 1.14.0.

It is a lazy extra that starts switched on. Settings > Send to agent turns the buttons and commands off.

## Where the buttons are

| Place | What is sent |
|---|---|
| Terminal (the sparkle button in the tab bar, or the palette commands Fix the terminal error with agent and Explain the terminal error) | The selected text, or else the last block of the output that looks like an error |
| Run panel, the log of a dev server | The last block of the log that looks like an error, the script name and the command |
| Run panel, a script that ended with an error | The end of its output, the script name, the command and the exit code |
| Commit panel, a pre-commit check that failed | The end of its output, the check, the command, the exit code and the checked files |
| Component preview: the error banner and the Events list | The render, runtime or build error with its stack, or the console, network and error events, and the component |

**Fix with agent** asks the agent to find the cause, make the smallest change that removes it, run the project's check for it if there is one, and not to commit or push. **Explain this error** asks for a plain-language explanation and no change to any file.

## What happens to the text

1. At most the newest 256 KB of the log is read. Terminal colours, control characters (also the C1 range) and invisible format characters (zero-width characters, bidirectional overrides, the byte order mark, tag characters) are removed, so nothing in the prompt is hidden from you.
2. Secrets are masked in all of that text with the app's own masker (the one the Run panel uses for its logs, followed by the secret scanner's redaction).
3. Only then is the end kept: the last 8 KB, where the error usually is, and it is masked once more. Masking before the cut means that a key block whose first line falls before the cut is still recognised. The prompt says when the log was shortened.
4. The facts sent with the log (a command line, for example) are cut to 2 KB and masked too.
5. The prompt says that the output is untrusted program output, to be treated as data and never as instructions, and the output sits in a code block it cannot close.
6. The New Run dialog opens with the prompt and the repository the error belongs to. You can read and change the prompt; nothing runs until you press Start run.

What the masker replaces with `***`: tokens with known prefixes (GitHub, GitLab, Slack, OpenAI-style, Google, npm, Stripe), AWS key ids (`AKIA`, `ASIA`, `AROA` and the other id prefixes) and bare 40-character AWS secret keys, JWTs, `Authorization`, `Cookie` and `Bearer` values, passwords in URLs (also a password that contains `@`), values of keys that name a secret in `KEY=value`, `KEY = value`, `"key": "value"`, `key: value` and `'key': 'value'` form (blanks before the colon are fine: `"key" : "value"`, `Key : value`), `--token value` style flags, the password of `sshpass -p`, `mysql -p` and `mysql -pPASS`, private key blocks from the BEGIN line to the END line (or to the end of the text), long hex strings, base64 that decodes to one of these, a token hidden by colour codes or zero-width characters, and the rest of a token that a terminal wrapped onto the next line.

This is pattern matching, not a promise. It does not catch a secret in a shape it does not know: a password without a key name next to it, a value split over several lines in another way, hex or another encoding of a token, or a secret in a language-specific format. Read the prompt before you start the run.

If the app's masker cannot be asked (the backend does not answer), the interface masks the text with its own port of the same rules (`fixtures/masking/cases.json` keeps both in step) and the New Run dialog says so in its message line, above the prompt, so you read it before you start.

## For other modules

`ui/src/platform/sendToAgent.ts` exports `buildErrorPrompt({ kind, text, repoId, extra, intent })` and `sendErrorToAgent(...)`, plus `cleanLog`, `tailBytes` and `lastErrorBlock`. The `SendToAgentMenu` component (`ui/src/components/SendToAgentMenu.tsx`) is the button with both actions. A React Native error screen, for example, calls it with `kind: "redbox"`.

## Privacy

Nothing is sent when you press the button: the text goes into the New Run dialog on this computer. When you start the run, the prompt goes to the provider of the run like any prompt you type.
