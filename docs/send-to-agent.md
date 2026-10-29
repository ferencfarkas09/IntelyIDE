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

1. Terminal colours and control characters are removed.
2. Only the last 8 KB is kept: the end of a log is where the error usually is. The prompt says when the log was shortened.
3. Secrets are masked with the app's own masker (the one the Run panel uses for its logs and the secret scanner's redaction): tokens with known prefixes, keyed values such as `PASSWORD=...`, bearer tokens, JWTs, passwords in URLs, long hex strings and private keys become `***`. The facts sent with the log (a command line, for example) are masked too. If the backend cannot be asked, a smaller masker in the interface does the same for the common shapes, so unmasked text is not passed on.
4. The New Run dialog opens with the prompt and the repository the error belongs to. You can read and change the prompt; nothing runs until you press Start run.

The masking is a strong filter, not a promise: a secret in a shape it does not know (split across lines, encoded) can get through. Read the prompt before you start the run.

## For other modules

`ui/src/platform/sendToAgent.ts` exports `buildErrorPrompt({ kind, text, repoId, extra, intent })` and `sendErrorToAgent(...)`, plus `cleanLog`, `tailBytes` and `lastErrorBlock`. The `SendToAgentMenu` component (`ui/src/components/SendToAgentMenu.tsx`) is the button with both actions. A React Native error screen, for example, calls it with `kind: "redbox"`.

## Privacy

Nothing is sent when you press the button: the text goes into the New Run dialog on this computer. When you start the run, the prompt goes to the provider of the run like any prompt you type.
