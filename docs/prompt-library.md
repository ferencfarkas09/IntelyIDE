# Prompt library

The prompt library keeps the prompts you write again and again, so a new agent run starts from a tested text instead of a blank box. Applies to version 1.14.0.

It is a lazy extra that starts switched on. Settings > Prompt library turns it off; your prompts stay saved while it is off.

## Where to find it

- **Saved prompts** next to the prompt box of the New Run dialog: search, pick one, and it is put into the box with its placeholders filled in. If the box already holds text, the prompt goes after it.
- **Run a saved prompt...** in the command palette: pick one and the New Run dialog opens with it, for the repository you are working in.
- **Open prompt library** in the command palette: the tab where prompts are written, copied, deleted, imported and exported.

Nothing runs by itself: a prompt only fills the New Run dialog, and the run starts when you press Start run.

## Placeholders

| Placeholder | Filled with |
|---|---|
| `{{selection}}` | The text selected in the editor (a selection of several lines becomes a code block) |
| `{{file}}` | The path of the file open in the editor, when it belongs to the run's repository |
| `{{branch}}` | The current branch of the repository |
| `{{repo}}` | The name of the repository |

Upper and lower case and spaces inside the braces do not matter. A value that is not known (no file open, nothing selected) becomes a short note such as `<selection>`, so you see in the prompt box what to fill in before you start. Anything else in double braces is left as written, and the editor says so.

## Your prompts and the starters

- **Starter prompts** ship with the app and cannot be changed: React (add tests, split a big component, loading and error states, accessibility), React Native (keyboard covering inputs, safe-area insets, a new screen with navigation, fewer re-renders), iOS and Android (signing errors, the build number, a permission string), Node (input validation, an endpoint with tests, structured logging), CSS and SCSS (responsive layout, design tokens, dark mode, dead styles) and general ones (explain code, review my changes, write a commit message, find the bug). Copy one to make it your own.
- **My prompts** are offered in every repository.
- **Only one repository**: a prompt can be tied to one repository of the workspace; it is offered only when that repository is part of the run.

Your prompts are stored in the app's settings file (namespace `prompts`), keyed by repository id for the per-repository ones. Nothing is written into a repository, so a prompt never shows up in a diff or a commit. Titles are limited to 120 characters, prompts to 20,000 characters, tags to 12 per prompt.

## Import and export

Export copies all your own prompts to the clipboard as JSON: the title, the text and the tags of each, no ids, no repository ids and no paths. Import reads such a file (at most 2 MB and 500 prompts) and adds its prompts to the place chosen in the form, each with a new id, so an import never overwrites a prompt you have. Entries without a title or a text are skipped and counted.

## Privacy

Prompts stay on this computer, in the settings file. Nothing is sent anywhere until you start a run with one, and then only to the provider of that run, like any prompt you type.
