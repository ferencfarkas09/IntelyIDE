// The starter prompts: read-only, for the stacks most vibe coders work in. Titles are translated (`prompts.starter.<id>`);
// the bodies are what the agent reads, in English, and can be copied into an own prompt and changed there.
import { t, type MessageKey } from "../../i18n";
import type { ScopedPrompt } from "./types";

interface Starter {
  id: string;
  tags: string[];
  body: string;
}

const NO_GIT = "Do not commit or push.";

const STARTERS: readonly Starter[] = [
  // React
  { id: "react-tests", tags: ["react", "test"], body: `Add tests for {{file}}.\n\nUse the test setup this project already has (look at package.json and an existing test first). Cover the main render, the user interactions and one edge case. Run the tests and make them pass. ${NO_GIT}` },
  { id: "react-split", tags: ["react", "refactor"], body: `{{file}} has grown too big. Split it into smaller components with clear names, each in its own file next to it.\n\nKeep the behaviour and the props of the outer component exactly the same. Run the type check and the tests afterwards. ${NO_GIT}` },
  { id: "react-states", tags: ["react", "ux"], body: `Add proper loading, empty and error states to {{file}}.\n\nWhile data loads show the loading pattern this project already uses; when a request fails show a short message with a way to retry; when there is no data say so. ${NO_GIT}` },
  { id: "react-a11y", tags: ["react", "accessibility"], body: `Make {{file}} accessible.\n\nCheck labels for every input and icon button, keyboard use (Tab order, Enter and Escape), focus visibility, semantic elements instead of clickable divs, alt text and colour contrast. Fix what is wrong and list what you changed. ${NO_GIT}` },
  // React Native
  { id: "rn-keyboard", tags: ["react-native", "ios", "android"], body: `On {{file}} the keyboard covers the input fields. Fix it on both iOS and Android.\n\nUse what the project already uses (KeyboardAvoidingView, a keyboard-aware scroll view or react-native-keyboard-controller). The focused field must stay visible and the screen must scroll. ${NO_GIT}` },
  { id: "rn-safe-area", tags: ["react-native", "ios", "android"], body: `Make {{file}} respect the safe areas (notch, status bar, home indicator, Android navigation bar).\n\nUse react-native-safe-area-context if the project has it. Check portrait and landscape. ${NO_GIT}` },
  { id: "rn-screen", tags: ["react-native", "navigation"], body: `Add a new screen called <ScreenName> and make it reachable from <where>.\n\nFollow how the existing screens and the navigator are set up in this project (React Navigation or Expo Router), add the route types, and give it a simple placeholder layout. ${NO_GIT}` },
  { id: "rn-rerenders", tags: ["react-native", "performance"], body: `{{file}} re-renders too often and feels slow. Find out why and reduce the re-renders.\n\nLook at props that change on every render (inline objects, functions), context updates, list items without stable keys and FlatList settings. Explain each change in one line. ${NO_GIT}` },
  // iOS and Android
  { id: "mobile-signing", tags: ["ios", "android", "build"], body: `My build fails with a code signing error. Here is the error:\n\n{{selection}}\n\nExplain in plain language what it means and fix what can be fixed in the project files. If something must be done in Xcode, the Apple Developer site or the Play Console, give me the exact steps instead of guessing. Never print or change certificates, keys or passwords. ${NO_GIT}` },
  { id: "mobile-build-number", tags: ["ios", "android", "release"], body: `Increase the build number of the app by one for iOS and Android (CURRENT_PROJECT_VERSION or Info.plist, versionCode, and app.json if it is an Expo app). Keep the version name as it is. Show me the before and after values. ${NO_GIT}` },
  { id: "mobile-permission", tags: ["ios", "android", "permissions"], body: `The app needs permission to use <camera / photos / location / microphone>. Add the permission string to Info.plist with a clear explanation for the user, the Android manifest entry, and ask for the permission at the right moment in the code with a friendly fallback when it is denied. ${NO_GIT}` },
  // Node
  { id: "node-validation", tags: ["node", "api"], body: `Add input validation to the endpoint(s) in {{file}}.\n\nUse the validation library this project already uses (zod, joi, yup, express-validator...), return a 400 with a clear message for bad input, and add a test for one valid and one invalid request. ${NO_GIT}` },
  { id: "node-endpoint", tags: ["node", "api", "test"], body: `Add a new endpoint: <METHOD /path> that <does what>.\n\nFollow how the existing routes, controllers and services are organised in this project, validate the input, handle errors the same way the other endpoints do, and add tests. ${NO_GIT}` },
  { id: "node-logging", tags: ["node", "logging"], body: `Replace the console.log calls in {{file}} with structured logging using the logger this project already has (or pino if there is none). Log levels must make sense, and no password, token or personal data may end up in a log line. ${NO_GIT}` },
  // CSS and SCSS
  { id: "css-responsive", tags: ["css", "scss", "layout"], body: `Make {{file}} responsive: it must look right from a 360 px phone to a wide desktop.\n\nUse the breakpoints and units the project already uses, avoid fixed widths, and check that nothing overflows horizontally. ${NO_GIT}` },
  { id: "css-tokens", tags: ["css", "scss", "design"], body: `Extract the colours, spacings, font sizes and radii used in {{file}} into design tokens (CSS custom properties or SCSS variables, whichever the project uses) and use the tokens instead of the raw values. The look must not change. ${NO_GIT}` },
  { id: "css-dark", tags: ["css", "scss", "theme"], body: `Add a dark mode to {{file}}.\n\nFollow prefers-color-scheme and any theme switch the project already has, use tokens instead of hard-coded colours, and keep the text contrast readable (WCAG AA). ${NO_GIT}` },
  { id: "css-dead", tags: ["css", "scss", "cleanup"], body: `Find styles in {{file}} that nothing uses anymore (search the components and templates for each class name) and remove them. List what you removed and anything you were not sure about and kept. ${NO_GIT}` },
  // General
  { id: "explain", tags: ["general"], body: "Explain this code in plain language, as if to someone who does not read code every day: what it does, how the parts fit together and what could go wrong.\n\n{{selection}}\n\nFile: {{file}}. Do not change any file." },
  { id: "review", tags: ["general", "review"], body: "Review my uncommitted changes on the branch {{branch}} of {{repo}} (git diff). Look for bugs, missing error handling, security problems and anything that does not match the rest of the code. List the problems by importance with file and line; do not change any file." },
  { id: "commit-message", tags: ["general", "git"], body: "Write a commit message for my uncommitted changes on {{branch}} (read git diff and git status). One short summary line in the style of this repository's git log, then a few lines on what changed and why. Only print the message; do not commit." },
  { id: "find-bug", tags: ["general", "debug"], body: `Something is wrong: <what you expected> but <what happens instead>.\n\n{{selection}}\n\nFind the cause before you change anything: read the related code, add a temporary log if it helps, and explain the cause in one or two sentences. Then make the smallest fix and remove the temporary logs. ${NO_GIT}` },
];

/** The starters, with titles in the current language. */
export function starterPrompts(): ScopedPrompt[] {
  return STARTERS.map((s) => ({ id: `starter:${s.id}`, title: t(`prompts.starter.${s.id}` as MessageKey), body: s.body, tags: s.tags, updatedAt: 0, scope: { kind: "starter" } }));
}

export const STARTER_IDS: readonly string[] = STARTERS.map((s) => s.id);
