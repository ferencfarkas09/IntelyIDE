// The token-saving habits a Claude run is told when Settings > Token saver > "Token-saving habits" is on (`agents.tokenHabits`,
// default off). The sidecar appends the same text (sidecar/src/adapters/claude-sdk/notes.ts); fixtures/token-habits/habits.txt
// pins both, so the preview in Settings and in Project notes is exactly what a run gets. It goes to the model, so it stays English.
export const TOKEN_HABITS_TEXT =
  "Token-saving habits. The user switched these on in IntelyIDE to keep the conversation small. They are habits, not rules: the safety rules of this session, the user's own instructions and the project's CLAUDE.md always win where they say otherwise.\n"
  + "- Read a file once per task and keep brief notes of what you need from it; read it again only when it changed or the notes are not enough.\n"
  + "- In a large file, search first (Grep or Glob with a narrow pattern and a result limit), then read only the lines you need with offset and limit.\n"
  + "- Do not read a file again right after you wrote or edited it: the edit result already shows the change.\n"
  + "- Skip generated, vendored, build and cache folders unless the task is about them: node_modules, dist, build, out, .next, .expo, .turbo, coverage, ios/Pods, ios/build, DerivedData, android/build, android/app/build, .gradle, target, .cache and similar.\n"
  + "- When a tool returns long output, keep the part that matters in a short summary instead of repeating it.";
